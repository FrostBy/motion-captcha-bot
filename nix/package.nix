{
  lib,
  buildNpmPackage,
  nodejs_22,
  makeWrapper,
  ffmpeg,
}:

buildNpmPackage {
  pname = "motion-captcha-bot";
  version = "0.1.0";
  nodejs = nodejs_22;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../src
      ../tsconfig.json
      ../tsconfig.test.json
      ../vitest.config.ts
    ];
  };

  npmDepsHash = "sha256-R3fvrDVNSth4AbCLx2EEofgFO6QmD4XF7n3lIZu6mtc=";
  npmBuildScript = "build";

  doCheck = true;
  # Vitest asks the OS to resolve localhost during startup. Darwin's Nix
  # sandbox blocks even loopback networking unless opted in.
  __darwinAllowLocalNetworking = true;
  checkPhase = ''
    runHook preCheck
    npm test
    npm run typecheck
    runHook postCheck
  '';

  nativeBuildInputs = [ makeWrapper ];
  installPhase = ''
    runHook preInstall

    npm prune --omit=dev
    mkdir -p $out/lib/motion-captcha-bot $out/bin
    cp -r dist node_modules package.json $out/lib/motion-captcha-bot/
    makeWrapper ${nodejs_22}/bin/node $out/bin/motion-captcha-bot \
      --add-flags "$out/lib/motion-captcha-bot/dist/main.js" \
      --prefix PATH : ${lib.makeBinPath [ ffmpeg ]}

    runHook postInstall
  '';

  meta = {
    description = "Telegram anti-spam bot with motion-readable captchas";
    homepage = "https://github.com/FrostBy/motion-captcha-bot";
    license = lib.licenses.mit;
    mainProgram = "motion-captcha-bot";
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-linux"
    ];
  };
}
