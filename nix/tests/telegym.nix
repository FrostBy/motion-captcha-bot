{
  lib,
  buildGo127Module,
  fetchFromGitHub,
}:
buildGo127Module (finalAttrs: {
  pname = "telegym";
  version = "0.9.0";

  src = fetchFromGitHub {
    owner = "kolomiichenko";
    repo = "telegym";
    tag = "v${finalAttrs.version}";
    hash = "sha256-bWc4eVeu9CbjIBeaBL30tkCJm036d9xHIRj4RXaxjjY=";
  };

  vendorHash = "sha256-cQ5OHD/uHT/VLLV2tKh0hyVjxQb/dzFKUgZdd7lVjqU=";

  # Vendor the production module independently of the separate k6 extension.
  env.GOWORK = "off";
  subPackages = [
    "cmd/telegym-mock"
    "cmd/telegym-proxy"
  ];
  ldflags = [
    "-s"
    "-w"
    "-X main.version=v${finalAttrs.version}"
  ];

  checkPhase = ''
    runHook preCheck
    go test ./...
    runHook postCheck
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    "$out/bin/telegym-mock" -version | grep -Fx "v${finalAttrs.version}"
    runHook postInstallCheck
  '';

  meta = {
    description = "Mock and proxy servers for the Telegram Bot API";
    homepage = "https://github.com/kolomiichenko/telegym";
    license = lib.licenses.mit;
    mainProgram = "telegym-mock";
    platforms = lib.platforms.linux;
  };
})
