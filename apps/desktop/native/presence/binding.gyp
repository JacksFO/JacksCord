{
  "targets": [
    {
      "target_name": "presence",
      "sources": [ "src/presence.cc" ],
      "include_dirs": [ "<!@(node -p \"require('node-addon-api').include\")" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE" ],
      "conditions": [
        [ "OS=='win'", {
          "libraries": [ "-lwindowsapp.lib", "-lshell32.lib", "-lgdi32.lib", "-luser32.lib" ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 2,
              "AdditionalOptions": [ "/std:c++17", "/EHa", "/bigobj" ]
            }
          }
        } ]
      ]
    }
  ]
}
