#pragma once
#include <string>
#include <vector>
#include "webapp_host.h"

// Loads the embedded webapp runtime (RCDATA 401-406, webapp_assets.rc).
bool NativeWebapp_LoadBuiltins(std::string& shimSource,
                               std::vector<native_three::WebappBuiltin>& builtins,
                               std::string& error);
