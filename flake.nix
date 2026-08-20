{
  description = "Motion-readable Telegram captcha bot";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.telegym.url = "github:booxter/telegym/lolek-missing-features";

  outputs =
    {
      self,
      nixpkgs,
      telegym,
      ...
    }:
    let
      supportedSystems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        rec {
          motion-captcha-bot = pkgs.callPackage ./nix/package.nix { };

          default = motion-captcha-bot;
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          nixos-service = import ./nix/tests/service.nix {
            inherit pkgs;
            module = self.nixosModules.default;
            package = self.packages.${system}.motion-captcha-bot;
            telegymModule = telegym.nixosModules.default;
            telegymPackage = telegym.packages.${system}.telegym;
          };
        }
      );

      nixosModules.default = import ./nix/module.nix { inherit self; };

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.ffmpeg
            ];
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
