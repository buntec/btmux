{
  lib,
  stdenv,
  fetchurl,
  unzip,
  dpkg,
  autoPatchelfHook,
  wrapGAppsHook3,
  makeWrapper,
  webkitgtk_4_1,
  glib-networking,
  openssl,
  libayatana-appindicator,
  xdotool,
}:

let
  version = "0.0.132";

  targets = {
    "aarch64-darwin" = "aarch64-apple-darwin";
    "aarch64-linux" = "aarch64-unknown-linux-gnu";
    "x86_64-linux" = "x86_64-unknown-linux-gnu";
  };

  hashes = {
    "aarch64-darwin" = "sha256-yke3HLA/u2aJWS4lVCq60ziD49RdcKmp4PSn/RJfNeo=";
    "aarch64-linux" = "sha256-6tuyrlVJYuBqJ19Q4eYD/GsV2hPSUxVj4yZ21O7Xn/o=";
    "x86_64-linux" = "sha256-9toXzBkVumA7xQuMfd4NQ4SuIaM8jd+6QRqolSxFuNE=";
  };

  system = stdenv.hostPlatform.system;
  target = targets.${system} or (throw "btmux desktop is not available on ${system}");
  extension = if stdenv.hostPlatform.isDarwin then "zip" else "deb";
in
stdenv.mkDerivation {
  pname = "btmux-desktop";
  inherit version;

  src = fetchurl {
    url = "https://github.com/buntec/btmux/releases/download/v${version}/btmux-desktop-${target}.${extension}";
    hash = hashes.${system};
  };

  nativeBuildInputs = [
    makeWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [ unzip ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [
    dpkg
    autoPatchelfHook
    wrapGAppsHook3
  ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    stdenv.cc.cc.lib
    webkitgtk_4_1
    glib-networking
    openssl
    libayatana-appindicator
    xdotool
  ];

  runtimeDependencies = lib.optionals stdenv.hostPlatform.isLinux [
    (lib.getLib libayatana-appindicator)
  ];

  sourceRoot = ".";
  unpackPhase = ''
    runHook preUnpack
    ${if stdenv.hostPlatform.isDarwin then ''unzip -q "$src"'' else ''dpkg-deb -x "$src" .''}
    runHook postUnpack
  '';
  dontConfigure = true;
  dontBuild = true;
  dontWrapGApps = true;
  dontStrip = stdenv.hostPlatform.isDarwin;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin"
  ''
  + (
    if stdenv.hostPlatform.isDarwin then
      ''
        mkdir -p "$out/Applications"
        cp -R btmux.app "$out/Applications/"
        makeWrapper "$out/Applications/btmux.app/Contents/MacOS/btmux-desktop" "$out/bin/btmux-desktop"
      ''
    else
      ''
        mkdir -p "$out/libexec/btmux-desktop"
        cp usr/bin/btmux usr/bin/btmux-desktop "$out/libexec/btmux-desktop/"
        cp -R usr/share "$out/share"
        substituteInPlace "$out/share/applications/btmux.desktop" \
          --replace-fail 'Exec=btmux-desktop' "Exec=$out/bin/btmux-desktop"
      ''
  )
  + ''
    runHook postInstall
  '';

  preFixup = lib.optionalString stdenv.hostPlatform.isLinux ''
    makeWrapper "$out/libexec/btmux-desktop/btmux-desktop" "$out/bin/btmux-desktop" "''${gappsWrapperArgs[@]}"
  '';

  meta = {
    description = "Desktop client for btmux with a bundled server";
    homepage = "https://github.com/buntec/btmux";
    license = lib.licenses.mit;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    mainProgram = "btmux-desktop";
    platforms = lib.attrNames targets;
  };
}
