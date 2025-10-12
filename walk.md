# Walkthrough

Simple steps for running the workspace and checking that everything works.

## 1. Install dependencies (one-time)
- Install Node.js 20+ and npm.
- In this folder run `npm install`.

## 2. Start helper services
- We use Redis to remember request fingerprints so the system can block duplicate work.
- Start Redis once with `brew services start redis`. It keeps running in the background.
- Check it replied with `PONG` using `redis-cli ping`.
- If you only want it for this session, run `/opt/homebrew/opt/redis/bin/redis-server /opt/homebrew/etc/redis.conf` instead and leave that window open.

## 3. Run quick smoke tests
- In another terminal run `npm run typecheck`.
- Then run `npm run test`.
- Both commands should finish with status ok.

## 4. Stop everything when done
- Stop any commands you started with `Ctrl+C`.
- If you started Redis just for the session, stop it with `Ctrl+C` or `brew services stop redis`.

## Troubleshooting
- `redis-cli ping` should always show `PONG`. If not, start Redis again.
- Run `npm run clean` followed by `npm install` if builds fail after upgrades.
