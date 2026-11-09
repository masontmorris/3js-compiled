# Environment for building the Servo spikes. Dot-source: . .\env.ps1

# MSVC developer environment (INCLUDE/LIB/PATH). bindgen's libclang needs INCLUDE to find the
# MSVC C++ headers (mozangle fails with "'array' file not found" otherwise).
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "Env:$($matches[1])" -Value $matches[2] }
}

$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\tools\nasm-3.02;$env:USERPROFILE\tools\llvm\bin;$env:PATH"
$env:LIBCLANG_PATH = "$env:USERPROFILE\tools\llvm\bin"
$env:CMAKE_GENERATOR = "Visual Studio 18 2026"
# One short, shared target/build dir: avoids MAX_PATH trouble and duplicate Servo builds.
$env:CARGO_TARGET_DIR = "C:\Users\mason\st"
$env:CARGO_BUILD_BUILD_DIR = "C:\Users\mason\st\build"
$env:CARGO_NET_GIT_FETCH_WITH_CLI = "true"
$env:CARGO_PROFILE_RELEASE_DEBUG = "0"
$env:CARGO_PROFILE_DEV_DEBUG = "0"
