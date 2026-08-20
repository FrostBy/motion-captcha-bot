{ self }:

{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.motion-captcha-bot;
in
{
  options.services.motion-captcha-bot = {
    enable = lib.mkEnableOption "motion-readable Telegram captcha bot";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.motion-captcha-bot;
      defaultText = lib.literalExpression "motion-captcha-bot.packages.\${pkgs.stdenv.hostPlatform.system}.motion-captcha-bot";
      description = "Motion Captcha Bot package to use.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Environment file containing BOT_TOKEN and optionally other secrets.";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Additional environment variables for the bot.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.environmentFile != null;
        message = "services.motion-captcha-bot.environmentFile must be set.";
      }
    ];

    systemd.services.motion-captcha-bot = {
      description = "Motion-readable Telegram captcha bot";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment = {
        DATA_FILE = "/var/lib/motion-captcha-bot/state.json";
      }
      // cfg.environment;
      serviceConfig = {
        DynamicUser = true;
        StateDirectory = "motion-captcha-bot";
        WorkingDirectory = "/var/lib/motion-captcha-bot";
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
      }
      // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      };
    };
  };
}
