/*
 * The two questions presence needs answered, asked of Windows directly.
 *
 *   whatIsPlaying()  - the track in whatever player is running, from the same
 *                      place the lock screen and the volume flyout read.
 *   runningNames()   - the base names of running programs, so a game can be
 *                      recognised.
 *
 * Native because the alternative was measured: a helper process left running
 * to answer these cost 72MB of memory for as long as the app was open, to
 * show a song title. In here it is two API calls inside a process that is
 * already running, and costs nothing to have.
 *
 * runningNames returns the whole list to the app, which then compares it
 * against the games somebody has added and sends only a match. The list is
 * never sent anywhere: that promise is kept in JavaScript, and this is only
 * the part that reads it.
 */
#include <napi.h>

#include <windows.h>
#include <tlhelp32.h>
#include <shellapi.h>
#include <psapi.h>
/* commctrl first: commoncontrols.h uses its types and constants and does not
   include it itself, so the other order fails to compile inside the SDK. */
#include <commctrl.h>
#include <commoncontrols.h>
#include <objbase.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
/* For the list of players: GetSessions hands back an IVectorView, whose Size
   and GetAt live here rather than in the media header. */
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Media.Control.h>
#include <winrt/Windows.Storage.Streams.h>

#include <string>
#include <algorithm>
#include <chrono>
#include <atomic>
#include <mutex>
#include <cctype>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Media::Control;
using namespace winrt::Windows::Storage::Streams;

namespace {

/*
 * One apartment for the life of the process, multi-threaded on purpose.
 *
 * The media API is asynchronous and this is a synchronous call, so the result
 * is waited for - and waiting inside a single-threaded apartment deadlocks
 * rather than waits. Done once and left alone; initialising per call is both
 * wasteful and a way to fight whatever else in the process has already picked
 * an apartment.
 */
bool EnsureApartment() {
  static bool ready = [] {
    try {
      init_apartment(apartment_type::multi_threaded);
      return true;
    } catch (...) {
      // Something else got there first with a different kind. That is fine to
      // live with - the calls below work either way - so this is not fatal.
      return true;
    }
  }();
  return ready;
}

std::string Utf8(std::wstring_view w) {
  if (w.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(),
                                    nullptr, 0, nullptr, nullptr);
  if (n <= 0) return {};
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), out.data(), n, nullptr, nullptr);
  return out;
}

const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string Base64(const std::vector<uint8_t>& in) {
  std::string out;
  out.reserve(((in.size() + 2) / 3) * 4);
  size_t i = 0;
  for (; i + 2 < in.size(); i += 3) {
    const uint32_t n = (in[i] << 16) | (in[i + 1] << 8) | in[i + 2];
    out += B64[(n >> 18) & 63]; out += B64[(n >> 12) & 63];
    out += B64[(n >> 6) & 63];  out += B64[n & 63];
  }
  if (i < in.size()) {
    const uint32_t n = (in[i] << 16) | (i + 1 < in.size() ? (in[i + 1] << 8) : 0);
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += (i + 1 < in.size()) ? B64[(n >> 6) & 63] : '=';
    out += '=';
  }
  return out;
}

/**
 * The cover, as a data URI, or nothing.
 *
 * Windows hands this over as a stream rather than a file, so it is read into
 * memory and turned into something an <img> can be pointed at. Whatever size
 * the player felt like providing - Spotify's is a few hundred pixels - and it
 * is made small again upstairs, where there is a canvas to do it with.
 *
 * Capped hard. This is a thumbnail beside a song title, and a player that
 * offered a megabyte of artwork would otherwise be believed.
 */
constexpr uint32_t MAX_ART = 4u * 1024u * 1024u;

std::string ThumbnailOf(const GlobalSystemMediaTransportControlsSessionMediaProperties& props) {
  try {
    auto ref = props.Thumbnail();
    if (!ref) return {};
    auto stream = ref.OpenReadAsync().get();
    if (!stream) return {};
    const uint64_t size = stream.Size();
    if (size == 0 || size > MAX_ART) return {};

    DataReader reader(stream);
    reader.LoadAsync(static_cast<uint32_t>(size)).get();
    std::vector<uint8_t> bytes(static_cast<size_t>(size));
    reader.ReadBytes(bytes);

    // What the player said it is, so the data URI does not have to guess. A
    // browser will sniff it anyway, but claiming the wrong thing is a lie in
    // a string somebody may read.
    std::string type = Utf8(stream.ContentType().c_str());
    if (type.rfind("image/", 0) != 0) type = "image/jpeg";
    return "data:" + type + ";base64," + Base64(bytes);
  } catch (...) {
    // No thumbnail, a player that withdrew it mid-read, or a stream that
    // refused. A card without a picture is a fine thing to have.
    return {};
  }
}

/**
 * What is playing, as plain data.
 *
 * Split from the object built for JavaScript so the reading can happen on a
 * thread that has no business touching a JavaScript engine. Everything here
 * is WinRT and standard library and nothing else.
 */
struct Playing {
  bool found = false;
  std::string app, title, artist, album;
  bool playing = false;
  int64_t at = 0, length = 0;
};

/*
 * Which player to read, when the machine has several.
 *
 * GetCurrentSession answers "whichever app last had the media session", which
 * is not the same question as "what is this person listening to". A browser
 * playing a stream takes it and keeps it, so Spotify becomes invisible while
 * it is still playing - and it comes back on its own only if somebody presses
 * a media key, which moves ownership rather than asking anybody.
 *
 * That is why this looked like it used to work and then stopped: the code did
 * not change, the machine did. One player is one session and GetCurrentSession
 * is always right about it.
 *
 * So the wanted player is asked for by name and looked for among all of them.
 * Playing beats paused, because two Spotify sessions (the app and a web
 * player) are a real thing and only one of them is making sound. With nothing
 * wanted, or nothing matching, this is exactly what it was before.
 */
GlobalSystemMediaTransportControlsSession PickSession(
    GlobalSystemMediaTransportControlsSessionManager const& manager,
    std::string const& want) {
  auto current = manager.GetCurrentSession();
  if (want.empty()) return current;
  try {
    GlobalSystemMediaTransportControlsSession paused{nullptr};
    /* By index rather than a range-for: the iterator for this collection is
       not visible from here, and this is a list of two. */
    auto all = manager.GetSessions();
    for (uint32_t i = 0; i < all.Size(); ++i) {
      auto s = all.GetAt(i);
      std::string id = Utf8(s.SourceAppUserModelId().c_str());
      std::transform(id.begin(), id.end(), id.begin(),
                     [](unsigned char c) { return (char)std::tolower(c); });
      if (id.find(want) == std::string::npos) continue;
      if (s.GetPlaybackInfo().PlaybackStatus() ==
          GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing) {
        return s;
      }
      if (!paused) paused = s;
    }
    if (paused) return paused;
  } catch (...) {
    // A player that closed while its list was being walked.
  }
  return current;
}

/* The player the app is interested in, lower case, set from JavaScript. Held
   here because the watcher below has to follow the same one as the reader,
   and it has no call to carry it on. */
std::string g_wantApp;

/*
 * The session manager the watcher is holding, if it is running.
 *
 * Declared here and defined beside the watcher, because the reading happens
 * further up this file than the watching does and the alternative is moving
 * one of them for the sake of the compiler.
 */
bool HeldManager(GlobalSystemMediaTransportControlsSessionManager& out);

Playing ReadPlaying(bool wantArt, std::string* art) {
  Playing out;
  try {
    /*
     * The one the watcher is already holding, where there is one.
     *
     * Asking for a session manager is not a cheap call that happens to be
     * repeated - it is a request to another process, which then enumerates
     * and hands back every player on the machine. Doing that per read meant
     * the Now Playing service did all of that work every time this app
     * wondered what was on, and that service was measured burning a whole
     * core for it.
     *
     * The watcher holds one for as long as it runs, and it is the same object
     * the same events come from, so there is nothing to be gained by asking
     * for another. Asked for only when nothing is watching - a one-off read
     * before the watcher has started, which is where this began.
     */
    GlobalSystemMediaTransportControlsSessionManager manager{nullptr};
    if (!HeldManager(manager)) {
      manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().get();
    }
    auto session = PickSession(manager, g_wantApp);
    if (!session) return out;

    auto props = session.TryGetMediaPropertiesAsync().get();
    auto timeline = session.GetTimelineProperties();
    auto playback = session.GetPlaybackInfo();

    out.found = true;
    out.app = Utf8(session.SourceAppUserModelId().c_str());
    out.title = Utf8(props.Title().c_str());
    out.artist = Utf8(props.Artist().c_str());
    out.album = Utf8(props.AlbumTitle().c_str());
    /*
     * Playing or not. Anything not actively playing is reported as such
     * rather than as nothing: "paused" and "no player at all" are different,
     * and the app shows neither the same way.
     */
    out.playing = playback.PlaybackStatus() ==
        GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
    // Milliseconds from 100ns ticks. Left at zero when the player never said,
    // because a length of zero draws a bar that is a lie.
    out.at = timeline.Position().count() / 10000;
    out.length = timeline.EndTime().count() / 10000;

    if (wantArt && art) *art = ThumbnailOf(props);
  } catch (...) {
    // No media service, no session, or a player that vanished mid-question.
    out.found = false;
  }
  return out;
}

Napi::Value BuildPlaying(Napi::Env env, const Playing& p, const std::string& art) {
  if (!p.found) return env.Null();
  Napi::Object out = Napi::Object::New(env);
  out.Set("app", Napi::String::New(env, p.app));
  out.Set("title", Napi::String::New(env, p.title));
  out.Set("artist", Napi::String::New(env, p.artist));
  out.Set("album", Napi::String::New(env, p.album));
  out.Set("playing", Napi::Boolean::New(env, p.playing));
  if (p.at > 0) out.Set("at", Napi::Number::New(env, (double)p.at));
  if (p.length > 0) out.Set("length", Napi::Number::New(env, (double)p.length));
  if (!art.empty()) out.Set("art", Napi::String::New(env, art));
  return out;
}

/**
 * What is playing, answered straight away.
 *
 * Kept beside the one that answers later because it is what a check from a
 * script wants, and because the artwork is only asked for on the other path.
 */
Napi::Value WhatIsPlaying(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!EnsureApartment()) return env.Null();
  const bool wantArt = info.Length() > 0 && info[0].ToBoolean().Value();
  std::string art;
  const Playing p = ReadPlaying(wantArt, &art);
  return BuildPlaying(env, p, art);
}

/**
 * The base names of everything running, lowercased.
 *
 * Handed to the app whole, which compares it against the games somebody added
 * and sends only a match. Nothing here decides what is interesting, because
 * the list of what is interesting is a preference and belongs where the
 * preferences are.
 */
Napi::Value RunningNames(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array out = Napi::Array::New(env);

  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return out;

  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  uint32_t i = 0;
  if (Process32FirstW(snap, &entry)) {
    do {
      std::wstring name(entry.szExeFile);
      for (auto& c : name) c = (wchar_t)towlower(c);
      out.Set(i++, Napi::String::New(env, Utf8(name)));
    } while (Process32NextW(snap, &entry));
  }
  CloseHandle(snap);
  return out;
}

/**
 * The full path of a running program, by its base name.
 *
 * Asked for by name rather than handed out with the list, deliberately. The
 * app already knows this name - it matched it against the games list - so
 * this reveals nothing it did not have. Handing every path up with every
 * check would have widened what leaves this function from "the names of what
 * is running" to "where all of it lives on disk", which is a different thing
 * to promise.
 *
 * LIMITED_INFORMATION because that is the least that answers the question,
 * and it works without being elevated. A game running as administrator when
 * this is not simply declines, and declines is a fine answer.
 */
std::wstring PathOfProcess(const std::wstring& wanted) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return {};

  std::wstring found;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snap, &entry)) {
    do {
      std::wstring name(entry.szExeFile);
      for (auto& c : name) c = (wchar_t)towlower(c);
      if (name != wanted) continue;

      HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
      if (!proc) continue;
      wchar_t path[MAX_PATH * 2]{};
      DWORD len = (DWORD)(sizeof(path) / sizeof(path[0]));
      if (QueryFullProcessImageNameW(proc, 0, path, &len)) found.assign(path, len);
      CloseHandle(proc);
      if (!found.empty()) break;
    } while (Process32NextW(snap, &entry));
  }
  CloseHandle(snap);
  return found;
}

/**
 * The pixels of an icon, straight rather than upside down.
 *
 * Windows keeps bitmaps bottom-up, so the height is given as negative to ask
 * for the other order rather than reversing the rows afterwards. The colour
 * order is BGRA and is swapped here, because everything upstairs - canvas,
 * ImageData, the lot - wants RGBA.
 *
 * Old icons carry no alpha at all: every pixel comes back fully transparent,
 * which would draw as nothing. Those have a separate mask bitmap, and it is
 * used when the alpha turns out to be empty rather than assumed either way.
 */
bool IconPixels(HICON icon, std::vector<uint8_t>& out, int& width, int& height) {
  ICONINFO info{};
  if (!GetIconInfo(icon, &info)) return false;

  BITMAP bm{};
  bool ok = false;
  if (GetObject(info.hbmColor, sizeof(bm), &bm) && bm.bmWidth > 0 && bm.bmHeight > 0) {
    width = bm.bmWidth;
    height = bm.bmHeight;

    BITMAPINFO bi{};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = width;
    bi.bmiHeader.biHeight = -height;  // top-down
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;

    out.assign(static_cast<size_t>(width) * height * 4, 0);
    HDC dc = GetDC(nullptr);
    if (GetDIBits(dc, info.hbmColor, 0, height, out.data(), &bi, DIB_RGB_COLORS)) {
      bool anyAlpha = false;
      for (size_t i = 3; i < out.size(); i += 4) if (out[i] != 0) { anyAlpha = true; break; }

      if (!anyAlpha && info.hbmMask) {
        // The mask is 1 where the pixel should be see-through.
        std::vector<uint8_t> mask(out.size(), 0);
        if (GetDIBits(dc, info.hbmMask, 0, height, mask.data(), &bi, DIB_RGB_COLORS)) {
          for (size_t i = 0; i < out.size(); i += 4) out[i + 3] = mask[i] ? 0 : 255;
        } else {
          for (size_t i = 3; i < out.size(); i += 4) out[i] = 255;
        }
      }

      for (size_t i = 0; i + 2 < out.size(); i += 4) std::swap(out[i], out[i + 2]);
      ok = true;
    }
    ReleaseDC(nullptr, dc);
  }

  if (info.hbmColor) DeleteObject(info.hbmColor);
  if (info.hbmMask) DeleteObject(info.hbmMask);
  return ok;
}

/**
 * The biggest icon Windows has for a file, or nothing.
 *
 * SHGetFileInfo's own icon is 32 pixels, which is soft by the time it is
 * drawn at 58 on a sharp screen. The shell keeps larger ones in an image
 * list, and a game generally ships a real 256.
 *
 * Not always, though: a program with only a small icon comes back as that
 * small icon sitting in the middle of a 256-pixel square of nothing, which
 * would draw as a speck in the corner of the tile. That is what the trimming
 * below is for.
 */
HICON BiggestIconFor(const std::wstring& path) {
  SHFILEINFOW sfi{};
  if (!SHGetFileInfoW(path.c_str(), 0, &sfi, sizeof(sfi), SHGFI_SYSICONINDEX)) return nullptr;

  IImageList* list = nullptr;
  for (const int size : { SHIL_JUMBO, SHIL_EXTRALARGE, SHIL_LARGE }) {
    if (FAILED(SHGetImageList(size, IID_PPV_ARGS(&list))) || !list) continue;
    HICON icon = nullptr;
    const HRESULT got = list->GetIcon(sfi.iIcon, ILD_TRANSPARENT, &icon);
    list->Release();
    list = nullptr;
    if (SUCCEEDED(got) && icon) return icon;
  }
  return nullptr;
}

/**
 * Cut away a fully transparent border.
 *
 * A small icon fetched from the jumbo list arrives centred in a great deal of
 * nothing. Sent as it is, the tile would show a speck; trimmed, it is the
 * icon at whatever size it really is, and the canvas upstairs scales it to
 * fit like any other.
 */
void TrimTransparent(std::vector<uint8_t>& px, int& width, int& height) {
  int minX = width, minY = height, maxX = -1, maxY = -1;
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      if (px[(static_cast<size_t>(y) * width + x) * 4 + 3] == 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  // Nothing visible at all, or nothing to cut.
  if (maxX < 0 || (minX == 0 && minY == 0 && maxX == width - 1 && maxY == height - 1)) return;

  const int w = maxX - minX + 1;
  const int h = maxY - minY + 1;
  std::vector<uint8_t> out(static_cast<size_t>(w) * h * 4);
  for (int y = 0; y < h; y++) {
    const uint8_t* from = &px[((static_cast<size_t>(y + minY)) * width + minX) * 4];
    std::copy(from, from + static_cast<size_t>(w) * 4, &out[static_cast<size_t>(y) * w * 4]);
  }
  px.swap(out);
  width = w;
  height = h;
}

/**
 * The icon a running game carries inside its own executable.
 *
 * Every Windows program has one, so this covers games nobody put on a list -
 * somebody installs something obscure and their friends see its real icon.
 * It is the program's icon rather than box art, which is less pretty than a
 * store banner and entirely honest about what it is.
 *
 * Raw pixels rather than a PNG: encoding one in C++ is a job, and there is a
 * canvas upstairs that does it already for the album covers.
 */
Napi::Value IconForName(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) return env.Null();

  std::string asked = info[0].As<Napi::String>();
  std::wstring wanted(asked.begin(), asked.end());
  for (auto& c : wanted) c = (wchar_t)towlower(c);

  const std::wstring path = PathOfProcess(wanted);
  if (path.empty()) return env.Null();

  HICON icon = BiggestIconFor(path);
  if (!icon) {
    // The shell's image lists refused; its own small icon is better than none.
    SHFILEINFOW sfi{};
    if (SHGetFileInfoW(path.c_str(), 0, &sfi, sizeof(sfi), SHGFI_ICON | SHGFI_LARGEICON)) {
      icon = sfi.hIcon;
    }
  }
  if (!icon) return env.Null();

  std::vector<uint8_t> pixels;
  int width = 0, height = 0;
  const bool got = IconPixels(icon, pixels, width, height);
  DestroyIcon(icon);
  if (!got) return env.Null();
  TrimTransparent(pixels, width, height);

  Napi::Object out = Napi::Object::New(env);
  out.Set("width", Napi::Number::New(env, width));
  out.Set("height", Napi::Number::New(env, height));
  out.Set("rgba", Napi::Buffer<uint8_t>::Copy(env, pixels.data(), pixels.size()));
  return out;
}

/* ---------------------------------------------------------- off the main --
 * The two expensive reads, done on a thread of their own.
 *
 * Reading a cover costs 424ms and the first icon about half a second, and
 * both used to happen on the main process's own thread - the one that also
 * carries the tray, the window and the global shortcuts. Four tenths of a
 * second is nothing to look at and a great deal to a key press: hold
 * push-to-talk while a song changes and it could land late, in a call, which
 * is the one place this feature has no business being felt at all.
 *
 * So they are asked for and answered later. Each worker sets up its own
 * apartment, because a thread that has not is a thread the media API will
 * not talk to.
 */
class PlayingWorker : public Napi::AsyncWorker {
 public:
  PlayingWorker(Napi::Env env, bool wantArt)
      : Napi::AsyncWorker(env), wantArt_(wantArt),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override {
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
    } catch (...) { /* already in one, which is fine */ }
    playing_ = ReadPlaying(wantArt_, &art_);
    found_ = playing_.found;
  }

  void OnOK() override {
    Napi::Env env = Env();
    deferred_.Resolve(found_ ? BuildPlaying(env, playing_, art_) : env.Null());
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  bool wantArt_;
  Napi::Promise::Deferred deferred_;
  bool found_ = false;
  Playing playing_{};
  std::string art_;
};

class IconWorker : public Napi::AsyncWorker {
 public:
  IconWorker(Napi::Env env, std::string name)
      : Napi::AsyncWorker(env), name_(std::move(name)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Execute() override {
    std::wstring wanted(name_.begin(), name_.end());
    for (auto& c : wanted) c = (wchar_t)towlower(c);
    const std::wstring path = PathOfProcess(wanted);
    if (path.empty()) return;

    HICON icon = BiggestIconFor(path);
    if (!icon) {
      SHFILEINFOW sfi{};
      if (SHGetFileInfoW(path.c_str(), 0, &sfi, sizeof(sfi), SHGFI_ICON | SHGFI_LARGEICON)) {
        icon = sfi.hIcon;
      }
    }
    if (!icon) return;
    found_ = IconPixels(icon, pixels_, width_, height_);
    DestroyIcon(icon);
    if (found_) TrimTransparent(pixels_, width_, height_);
  }

  void OnOK() override {
    Napi::Env env = Env();
    if (!found_) { deferred_.Resolve(env.Null()); return; }
    Napi::Object out = Napi::Object::New(env);
    out.Set("width", Napi::Number::New(env, width_));
    out.Set("height", Napi::Number::New(env, height_));
    out.Set("rgba", Napi::Buffer<uint8_t>::Copy(env, pixels_.data(), pixels_.size()));
    deferred_.Resolve(out);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  std::string name_;
  Napi::Promise::Deferred deferred_;
  bool found_ = false;
  std::vector<uint8_t> pixels_;
  int width_ = 0, height_ = 0;
};

/* -------------------------------------------------------- being told -----
 * Windows will say when a track changes, rather than being asked.
 *
 * Polling for music was only ever convenience - the same five-second timer
 * that looks for games - and it costs two things: a track appears up to five
 * seconds after it started, and every one of those checks is work done to
 * discover nothing. The media session raises an event instead, on a thread of
 * its own, so the answer arrives the moment it changes and the reading
 * happens nowhere near the main one.
 *
 * A threadsafe function is how a WinRT thread is allowed to reach JavaScript
 * at all: it hands the work back to the main loop rather than touching the
 * engine from outside it, which is a crash rather than a race.
 */
struct Watcher {
  GlobalSystemMediaTransportControlsSessionManager manager{nullptr};
  GlobalSystemMediaTransportControlsSession session{nullptr};
  winrt::event_token onSessionChanged{};
  winrt::event_token onSessionsChanged{};
  winrt::event_token onMediaChanged{};
  winrt::event_token onPlaybackChanged{};
  winrt::event_token onTimelineChanged{};
  Napi::ThreadSafeFunction tell;
  /* Read without the lock by the handlers, so they can leave without waiting
     for a teardown that is waiting for them. */
  std::atomic<bool> running{false};
};

Watcher watcher;

/*
 * One thread at a time in here.
 *
 * Everything above is touched from four places at once and was guarded by
 * nothing at all: the completion that starts the watching, the two manager
 * events - which fire on whichever pool thread is free, and can fire
 * together - the reader on its worker, and whoever calls stop.
 *
 * Following a session is not one write. It is: let go of three handlers, drop
 * the session, choose another, take three more. Two of those running at once
 * hand back the same handlers twice and drop the same session twice, and the
 * second time is against something already freed. Which is a crash inside
 * either this file or the Windows media DLL depending on whose frame is on
 * top when it goes - and both of those have been in the crash log every few
 * hours since this was written.
 *
 * Recursive because starting takes the lock and then follows a session, which
 * takes it again.
 *
 * The rule for holding it: only for reads and writes of the fields above.
 * Handing a handler back can block until a call already inside it returns, so
 * doing that while holding this would be a deadlock the moment the call it is
 * waiting for wants the lock. Anything blocking happens on a local copy after
 * the lock has been let go.
 */
std::recursive_mutex watcherLock;

bool HeldManager(GlobalSystemMediaTransportControlsSessionManager& out) {
  /* Under the lock, because this runs on a worker while the watcher may be
     replacing or dropping the very thing being copied. Copying takes a
     reference, so what goes back stays alive on its own afterwards. */
  std::lock_guard<std::recursive_mutex> hold(watcherLock);
  if (!watcher.running || !watcher.manager) return false;
  out = watcher.manager;
  return true;
}

void TellThem() {
  if (!watcher.running) return;
  watcher.tell.NonBlockingCall([](Napi::Env env, Napi::Function cb) {
    /* Read here rather than on the WinRT thread: this is a moment on the main
       loop, and the reading itself is queued from JavaScript so it lands on a
       worker like every other read. What is passed is only "something
       changed". */
    cb.Call({});
  });
}

/*
 * Whether the position moved by itself, or somebody moved it.
 *
 * Steady play advances the position by however long has passed since the last
 * look, so the two track each other and the difference stays near nothing. A
 * seek breaks that: the position lands somewhere the clock cannot explain.
 *
 * The allowance is generous on purpose - players round, report late, and stall
 * for a moment on a slow network - and being wrong here is only ever a bar
 * that catches up a second later, against a cost of waking everything.
 *
 * A new track resets it rather than counting as a seek, because the track
 * changing has its own event and this one must not say it twice.
 */
/* Atomic because these are touched from whichever pool thread the media
   event arrives on, and two players changing at once is ordinary. Nothing
   here needs the pair to be consistent with each other - being wrong once
   costs a single extra wake - but a torn read of a 64-bit value is not
   something to leave to the platform. */
std::atomic<int64_t> g_lastPos{-1};
std::atomic<int64_t> g_lastAt{0};
const int64_t SEEK_SLACK_MS = 2500;

int64_t NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}

void ForgetPosition() {
  g_lastPos = -1;
  g_lastAt = 0;
}

bool Seeked(GlobalSystemMediaTransportControlsSession const& session) {
  try {
    const int64_t pos = session.GetTimelineProperties().Position().count() / 10000;
    const int64_t now = NowMs();
    const int64_t was = g_lastPos;
    const int64_t when = g_lastAt;
    g_lastPos = pos;
    g_lastAt = now;
    /* Nothing to compare against yet: the first tick after a track or a
       player changes is not a seek. */
    if (was < 0 || when == 0) return false;
    const int64_t expected = was + (now - when);
    const int64_t off = pos > expected ? pos - expected : expected - pos;
    return off > SEEK_SLACK_MS;
  } catch (...) {
    /* A player that vanished mid-question. Say nothing rather than wake
       everybody over an exception. */
    return false;
  }
}

/** Follow whichever session is current, and let go of the last one. */
void FollowSession() {
  /*
   * Held for the whole of it, because this is a sequence and not a write -
   * two of these at once is the crash this lock exists for.
   *
   * Handing back a session's handlers is done in here, which is safe: those
   * handlers take no lock, so a call already inside one cannot be waiting on
   * this. The manager's handlers are the ones that do, and they are only ever
   * handed back by stop, outside the lock.
   */
  std::lock_guard<std::recursive_mutex> hold(watcherLock);
  if (!watcher.running) return;
  try {
    if (watcher.session) {
      watcher.session.MediaPropertiesChanged(watcher.onMediaChanged);
      watcher.session.PlaybackInfoChanged(watcher.onPlaybackChanged);
      watcher.session.TimelinePropertiesChanged(watcher.onTimelineChanged);
      watcher.session = nullptr;
    }
    watcher.session = PickSession(watcher.manager, g_wantApp);
    /* A different player's position has nothing to do with the last one's. */
    ForgetPosition();
    if (!watcher.session) return;

    watcher.onMediaChanged = watcher.session.MediaPropertiesChanged(
        [](auto&&, auto&&) {
          /* The track changed, so the position starts again somewhere new -
             which is not somebody seeking, and must not be counted as one on
             the next tick. */
          ForgetPosition();
          TellThem();
        });
    watcher.onPlaybackChanged = watcher.session.PlaybackInfoChanged(
        [](auto&&, auto&&) { TellThem(); });
    /*
     * And where it has got to.
     *
     * Without this a rewind was invisible: the track had not changed and the
     * playback had not changed, so nothing woke anybody and the bar carried
     * on from where the song used to be. Reported exactly that way.
     *
     * Decided here, and this is the whole point of it. This event fires for
     * as long as anything plays - measured against Spotify, every 4.5 seconds
     * - and every one of those used to wake JavaScript, which asked what was
     * playing, and asking builds a whole new session manager and walks every
     * player on the machine. So about twenty thousand times a day, while a
     * track simply played, this app made the Now Playing service enumerate
     * everything to learn that a few seconds had passed.
     *
     * Measured over a minute of real playback, before and after:
     *
     *   waking on every timeline event   14 wakes
     *   waking only on a jump             1 wake  (the first, on connecting)
     *
     * Time passing is exactly what the position doing what it should looks
     * like, and it is the one thing nobody needs telling about: the card
     * carries the bar forward on its own. A seek does not look like
     * that - it jumps - and a jump is worth waking for.
     *
     * The comparison is here rather than up in JavaScript because up there it
     * is already too late: the expensive part is the asking, and by then it
     * has been done. Nothing here asks anything. The session is already held
     * and its timeline is a property of it, so this costs a read of two
     * numbers and no call to anybody.
     */
    watcher.onTimelineChanged = watcher.session.TimelinePropertiesChanged(
        [](auto&& sender, auto&&) { if (Seeked(sender)) TellThem(); });
  } catch (...) {
    // A player that vanished between one line and the next.
  }
}

/**
 * Start following whatever is playing, without standing still to do it.
 *
 * Asking Windows for the media session manager took nine and a half seconds
 * on the machine this was found on, and it was asked for with `.get()` - so
 * the whole app stopped on every start and every reload, for as long as
 * Windows felt like taking. Measured rather than guessed: the process sat on
 * an LpcReply wait using no processor time at all, which is what waiting for
 * another process to answer looks like from outside.
 *
 * It is the same call the rest of this file already treats as slow -
 * whatIsPlayingLater and iconForNameLater exist for exactly that reason -
 * and this one was the last that had not been given the same treatment.
 *
 * So: hand the request a completion instead of waiting on it. Everything
 * after it already runs on a WinRT thread - the session handlers below fire
 * on one - and everything they touch goes back to JavaScript through the
 * thread-safe function, which is why this is safe to move off the calling
 * thread and would not have been otherwise.
 */
Napi::Value WatchMedia(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) return Napi::Boolean::New(env, false);
  if (watcher.running) return Napi::Boolean::New(env, true);
  if (!EnsureApartment()) return Napi::Boolean::New(env, false);

  /* Made here, before anything is handed away: a thread-safe function has to
     be created on the thread JavaScript runs on, and nothing below this line
     is promised to be that thread. */
  watcher.tell = Napi::ThreadSafeFunction::New(
      env, info[0].As<Napi::Function>(), "media-changed", 0, 1);
  /* Set before the request rather than after it, so a second call while this
     one is still in the air is answered with "already watching" instead of
     starting a second watcher nobody can stop. */
  watcher.running = true;

  try {
    auto pending = GlobalSystemMediaTransportControlsSessionManager::RequestAsync();
    pending.Completed([](auto const& op, winrt::Windows::Foundation::AsyncStatus status) {
      /* Stopped while we were waiting. Whoever stopped it has already given
         the callback back, so there is nothing to undo and nothing to keep. */
      if (!watcher.running) return;
      if (status != winrt::Windows::Foundation::AsyncStatus::Completed) {
        watcher.running = false;
        watcher.tell.Release();
        return;
      }
      try {
        /* Recursive: this takes the lock and then follows a session, which
           takes it again. */
        std::lock_guard<std::recursive_mutex> hold(watcherLock);
        if (!watcher.running) return;
        watcher.manager = op.GetResults();
        watcher.onSessionChanged = watcher.manager.CurrentSessionChanged([](auto&&, auto&&) {
          FollowSession();
          TellThem();
        });
        /*
         * And when the set of players changes at all.
         *
         * Opening Spotify while a browser holds the session adds a session
         * without changing which one is current, so nothing above would have
         * fired and the new player would not be followed until something else
         * happened to wake this.
         */
        watcher.onSessionsChanged = watcher.manager.SessionsChanged([](auto&&, auto&&) {
          FollowSession();
          TellThem();
        });
        FollowSession();
        /* Say so once, now there is something to say: the first reading used
           to happen before this function returned. */
        TellThem();
      } catch (...) {
        watcher.running = false;
        watcher.tell.Release();
      }
    });
    return Napi::Boolean::New(env, true);
  } catch (...) {
    watcher.running = false;
    watcher.tell.Release();
    return Napi::Boolean::New(env, false);
  }
}

Napi::Value StopWatchingMedia(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  /*
   * Taken away first, given back afterwards.
   *
   * Handing a handler back waits for any call already inside it to return,
   * and the manager's handlers follow a session, which wants the lock. So
   * doing that while holding the lock is a deadlock: this waits for the
   * handler, the handler waits for this.
   *
   * Instead the lock is held only long enough to take the objects out of the
   * watcher and say it has stopped. Anything already on its way in sees that
   * and leaves without touching a thing, and the waiting is then done out
   * here on copies nobody else can reach.
   */
  GlobalSystemMediaTransportControlsSession session{nullptr};
  GlobalSystemMediaTransportControlsSessionManager manager{nullptr};
  winrt::event_token media{}, playback{}, timeline{}, current{}, sessions{};
  {
    std::lock_guard<std::recursive_mutex> hold(watcherLock);
    if (!watcher.running) return Napi::Boolean::New(env, false);
    watcher.running = false;
    session = watcher.session;   watcher.session = nullptr;
    manager = watcher.manager;   watcher.manager = nullptr;
    media = watcher.onMediaChanged;
    playback = watcher.onPlaybackChanged;
    timeline = watcher.onTimelineChanged;
    current = watcher.onSessionChanged;
    sessions = watcher.onSessionsChanged;
  }

  try {
    if (session) {
      session.MediaPropertiesChanged(media);
      session.PlaybackInfoChanged(playback);
      session.TimelinePropertiesChanged(timeline);
    }
    if (manager) {
      manager.CurrentSessionChanged(current);
      /* And the one added for players appearing while another holds the
         session. Every other handler here is given back; leaving this one
         subscribed leaves a callback pointing at a manager we have dropped,
         on the shutdown path of a process that has to exit cleanly for an
         update to be able to replace it. */
      manager.SessionsChanged(sessions);
    }
  } catch (...) { /* already gone */ }
  ForgetPosition();
  watcher.tell.Release();
  return Napi::Boolean::New(env, true);
}

Napi::Value WhatIsPlayingLater(const Napi::CallbackInfo& info) {
  const bool wantArt = info.Length() > 0 && info[0].ToBoolean().Value();
  auto* worker = new PlayingWorker(info.Env(), wantArt);
  auto promise = worker->Promise();
  worker->Queue();
  return promise;
}

Napi::Value IconForNameLater(const Napi::CallbackInfo& info) {
  if (info.Length() < 1 || !info[0].IsString()) return info.Env().Null();
  auto* worker = new IconWorker(info.Env(), info[0].As<Napi::String>());
  auto promise = worker->Promise();
  worker->Queue();
  return promise;
}

}  // namespace


/**
 * The process id of a running program, by its base name.
 *
 * Asked once, when a game is first noticed, so that every check after it can
 * be StillRunning below rather than another snapshot of the whole machine.
 * Zero when nothing of that name is running.
 */
Napi::Value PidForName(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) return Napi::Number::New(env, 0);

  std::string utf8 = info[0].As<Napi::String>().Utf8Value();
  std::wstring wanted(utf8.begin(), utf8.end());
  for (auto& c : wanted) c = (wchar_t)towlower(c);

  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return Napi::Number::New(env, 0);

  DWORD found = 0;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snap, &entry)) {
    do {
      std::wstring name(entry.szExeFile);
      for (auto& c : name) c = (wchar_t)towlower(c);
      if (name == wanted) { found = entry.th32ProcessID; break; }
    } while (Process32NextW(snap, &entry));
  }
  CloseHandle(snap);
  return Napi::Number::New(env, (uint32_t)found);
}

/**
 * Whether that exact process is still running, without a snapshot.
 *
 * A game runs for hours, and for every one of those hours the only question
 * being asked is "is it still on". Answering that by listing every process on
 * the machine every five seconds is the expensive way round: the measurement
 * that prompted this put the listing at 5.2ms a time and the part that
 * crosses into JavaScript at 0.15ms of it, so the cost is the listing itself
 * and the only saving available is not doing it.
 *
 * Opening a handle to one known id costs microseconds instead.
 *
 * The name is checked as well as the id, because Windows reuses process ids.
 * Without that, a game closing and something else starting into its id would
 * read as the game still running - which is a person shown as playing
 * something they shut down an hour ago, and the exact fault presence is
 * supposed not to have.
 */
Napi::Value StillRunning(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
    return Napi::Boolean::New(env, false);
  }
  DWORD pid = (DWORD)info[0].As<Napi::Number>().Uint32Value();
  if (pid == 0) return Napi::Boolean::New(env, false);

  std::string utf8 = info[1].As<Napi::String>().Utf8Value();
  std::wstring wanted(utf8.begin(), utf8.end());
  for (auto& c : wanted) c = (wchar_t)towlower(c);

  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) return Napi::Boolean::New(env, false);

  bool same = false;
  wchar_t path[MAX_PATH * 2]{};
  DWORD len = (DWORD)(sizeof(path) / sizeof(path[0]));
  if (QueryFullProcessImageNameW(proc, 0, path, &len)) {
    std::wstring full(path, len);
    size_t slash = full.find_last_of((wchar_t)92);
    std::wstring base = slash == std::wstring::npos ? full : full.substr(slash + 1);
    for (auto& c : base) c = (wchar_t)towlower(c);
    same = (base == wanted);
  }
  CloseHandle(proc);
  return Napi::Boolean::New(env, same);
}

/** Which player to prefer, by part of its app id. Lower case; "" for none. */
Napi::Value PreferApp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string want = info.Length() > 0 && info[0].IsString()
      ? info[0].As<Napi::String>().Utf8Value() : std::string();
  std::transform(want.begin(), want.end(), want.begin(),
                 [](unsigned char c) { return (char)std::tolower(c); });
  g_wantApp = want;
  /* The watcher is listening to whichever session it picked last, which may
     no longer be the right one. */
  if (watcher.running) FollowSession();
  return Napi::Boolean::New(env, true);
}

/*
 * Every player Windows can see, and whether each is making a sound.
 *
 * Kept because it is the only way to tell three states apart that look
 * identical from the app: the wanted player is not running, it is running but
 * publishing nothing, or it is there and something else simply owns the
 * session. Finding that Spotify publishes nothing until it is restarted took
 * one call to this and would otherwise have been guesswork.
 */
Napi::Value PlayerApps(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array out = Napi::Array::New(env);
  if (!EnsureApartment()) return out;
  try {
    auto manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().get();
    auto all = manager.GetSessions();
    for (uint32_t i = 0; i < all.Size(); ++i) {
      auto s = all.GetAt(i);
      std::string id = Utf8(s.SourceAppUserModelId().c_str());
      bool playing = s.GetPlaybackInfo().PlaybackStatus() ==
          GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
      out.Set(i, Napi::String::New(env, id + (playing ? " [playing]" : " [not playing]")));
    }
  } catch (...) {}
  return out;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("playerApps", Napi::Function::New(env, PlayerApps));
  exports.Set("preferApp", Napi::Function::New(env, PreferApp));
  exports.Set("whatIsPlaying", Napi::Function::New(env, WhatIsPlaying));
  exports.Set("runningNames", Napi::Function::New(env, RunningNames));
  exports.Set("pidForName", Napi::Function::New(env, PidForName));
  exports.Set("stillRunning", Napi::Function::New(env, StillRunning));
  exports.Set("iconForName", Napi::Function::New(env, IconForName));
  exports.Set("whatIsPlayingLater", Napi::Function::New(env, WhatIsPlayingLater));
  exports.Set("iconForNameLater", Napi::Function::New(env, IconForNameLater));
  exports.Set("watchMedia", Napi::Function::New(env, WatchMedia));
  exports.Set("stopWatchingMedia", Napi::Function::New(env, StopWatchingMedia));
  return exports;
}

NODE_API_MODULE(presence, Init)
