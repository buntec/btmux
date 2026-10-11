{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
}:

let
  version = "0.0.132";

  targets = {
    "aarch64-darwin" = "aarch64-apple-darwin";
    "aarch64-linux" = "aarch64-unknown-linux-gnu";
    "x86_64-linux" = "x86_64-unknown-linux-gnu";
  };

  hashes = {
    "aarch64-darwin" = "sha256-wrFFCFLwygr+XEzZ1ACueJJy2vVKMNE8oTpGFCMlP80=";
    "aarch64-linux" = "sha256-M8vJkVr01O1sYpTCrFMR6DuFzR5Jb3hQhfJDauQh2Ig=";
    "x86_64-linux" = "sha256-Pfca+6EOIhEJAVLsqkBEUCX0vn96sPA7oBDqCQxpQlM=";
  };

  system = stdenv.hostPlatform.system;
  target = lib.attrByPath [ system ] (throw "btmux is not available on ${system}") targets;
  hash = lib.attrByPath [ system ] (throw "no btmux hash for ${system}") hashes;
in
stdenv.mkDerivation {
  pname = "btmux";
  inherit version;

  src = fetchurl {
    url = "https://github.com/buntec/btmux/releases/download/v${version}/btmux-${target}";
    inherit hash;
  };

  dontUnpack = true;
  dontConfigure = true;
  dontBuild = true;
  dontCheck = true;

  nativeBuildInputs = lib.optional stdenv.hostPlatform.isLinux autoPatchelfHook;
  buildInputs = lib.optional stdenv.hostPlatform.isLinux stdenv.cc.cc.lib;

  installPhase = ''
    install -Dm755 "$src" "$out/bin/btmux"
  '';

  meta = {
    description = "Browser-based terminal manager";
    homepage = "https://github.com/buntec/btmux";
    license = lib.licenses.mit;
    mainProgram = "btmux";
    platforms = lib.attrNames targets;
  };
}
