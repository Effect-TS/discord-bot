{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    systems.url = "github:nix-systems/default";
    process-compose-flake.url = "github:Platonic-Systems/process-compose-flake";
    services-flake.url = "github:juspay/services-flake";
  };
  outputs = inputs @ {flake-parts, ...}:
    flake-parts.lib.mkFlake {inherit inputs;} {
      systems = import inputs.systems;
      imports = [
        inputs.process-compose-flake.flakeModule
      ];
      perSystem = {
        self',
        pkgs,
        system,
        ...
      }: {
        process-compose."default" = {config, ...}: {
          imports = [
            inputs.services-flake.processComposeModules.default
          ];

          settings.processes.docker = {
            command = "docker compose up";
            shutdown = {
              signal = 2;
            };
            readiness_probe = {
              initial_delay_seconds = 15;
              http_get = {
                host = "localhost";
                port = 4000;
                scheme = "http";
                path = "/api/health";
              };
            };
          };

          settings.processes.discord-bot = {
            command = "node packages/discord-bot/src/main.ts";
          };
        };

        devShells.default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            corepack_24
            nodejs_24
            flyctl
          ];
        };
      };
    };
}
