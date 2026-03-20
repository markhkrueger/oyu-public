# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OYU is a TypeScript/Node.js system for monitoring and controlling hot water circulation. It consists of the source file flow_server.ts 
## Build & Test Commands

```bash
npm test          # Run Jest test suite (ts-jest compiles on the fly)
npx tsc           # Compile TypeScript to out/ directory
```

There is no build script in package.json; compile with `tsc` directly. Output goes to `out/`.

To run a single test file or specific test:
```bash
npx jest foo.test.ts
npx jest -t "test name pattern"
```

## Architecture

flow_server.ts is a TypeScript/Node.js system for monitoring and controlling hot water circulation. It consists of the source file flow_server.ts 

## Key Technical Details

- **TypeScript config:** target ES6, CommonJS modules, source maps enabled
- **Test framework:** Jest 30 with ts-jest preset; test files are `*.test.ts` at project root
- **ESLint rules:** semicolons required, no explicit `any`, no dynamic `require`, prefer `readonly` properties, exhaustive switch checks
- **Concurrency:** uses `async-mutex` for thread-safe async operations
- **Git submodule:** `raspi-1wire-temp` provides 1-wire temperature sensor interface
- **Configuration:** `oyu_settings.json` stores server ports, Homebridge connection details, GPIO pins, and flow thresholds
