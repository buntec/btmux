{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
}:

let
  version = "0.0.98";

  targets = {
    "aarch64-darwin" = "aarch64-apple-darwin";
    "aarch64-linux" = "aarch64-unknown-linux-gnu";
    "x86_64-linux" = "x86_64-unknown-linux-gnu";
  };

  hashes = {
    "aarch64-darwin" = "sha256-ARFgDW/u/AVkewp9df0ZgeUxcGN0A274N9NXd/RLnyw=";
    "aarch64-linux" = "sha256-7dKj0QoAVSnW224UWOLptZyll6g8RxVDXe4+VksMhTE=";
    "x86_64-linux" = "sha256-O4WUjZEblEqCZ3OujL844k8nVcQRyo4baY+mmYXW+LM=";
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
