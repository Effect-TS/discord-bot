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
              http_get = {
                host = "localhost";
                port = 4000;
                scheme = "http";
                path = "/api/health";
              };
            };
          };

          settings.processes.shard-manager = {
            command = "tsx --watch packages/shard-manager/src/main.ts";
          };
          settings.processes.shard-manager.depends_on = {
            pg.condition = "process_healthy";
          };

          settings.processes.runner = {
            command = "tsx --watch packages/runner/src/main.ts";
          };
          settings.processes.runner.depends_on.shard-manager.condition = "process_started";

          settings.processes.discord-bot = {
            command = "tsx --watch packages/discord-bot/src/main.ts";
          };
          settings.processes.discord-bot.depends_on.shard-manager.condition = "process_started";
        };

        devShells.default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            corepack
            nodejs
            flyctl
            postgresql
          ];

          shellHook = ''
            export DATABASE_URL=postgresql://localhost/chat-cluster
          '';
        };
      };
    };
}
