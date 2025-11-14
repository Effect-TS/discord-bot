{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    nixpkgs-stable.url = "github:nixos/nixpkgs/25.05";
    flake-parts.url = "github:hercules-ci/flake-parts";
    systems.url = "github:nix-systems/default";
    process-compose-flake.url = "github:Platonic-Systems/process-compose-flake";
    services-flake.url = "github:juspay/services-flake";
  };
  outputs = inputs @ {
    flake-parts,
    nixpkgs-stable,
    ...
  }:
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
      }: let
        pkgs-stable = import inputs.nixpkgs-stable {
          inherit system;
        };
      in {
        process-compose."default" = {config, ...}: {
          imports = [
            inputs.services-flake.processComposeModules.default
          ];

          services.postgres.pg = {
            enable = true;
            initialDatabases = [{name = "chat-cluster";}];
            extensions = extensions: [extensions.pgvector];
            socketDir = "/tmp";
          };

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

          settings.processes.runner = {
            command = "tsx --watch packages/runner/src/main.ts";
          };

          settings.processes.discord-bot = {
            command = "tsx --watch packages/discord-bot/src/main.ts";
          };
          settings.processes.discord-bot.depends_on.runner.condition = "process_started";
        };

        devShells.default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            corepack
            nodejs_24
            pkgs-stable.flyctl
            postgresql
          ];

          shellHook = ''
            export DATABASE_URL=postgresql://localhost/chat-cluster
          '';
        };
      };
    };
}
