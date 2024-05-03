# Screepy

Timmy like Screeps AI

## Install

Copy `screeps.example.json` to `screeps.json` and edit the file with you Steam Api Key:

Then Run:

```bash
npm install
```

Push to Screeps server with the following commands:

```bash
npm run push-main
npm run push-sim
npm run push-seasonal
npm run push-pserver
npm run push-screepsplus
```

## Run dev server

Copy `config.example.yml` to `config.yml` and edit the file with you Steam Api Key:

Then run:

```bash
docker compose up -d
```

## TODO List

- [x] Basic Spawn logic
- [x] Basic Creep logic
- [x] Basic Room logic
- [ ] profiler
- [x] Basic Memory logic
- [ ] Room Planner
- [ ] Metrics and Monitoring
- [ ] WTF do i want ?
