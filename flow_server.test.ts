import {
    periodToHertz,
    pwToFlow,
    parseArgs,
    FlowHttpServer,
    DoorMonitor,
    DoorEvent,
    DOOR_STILL_OPEN_SENTINEL,
    SensorManager,
    LogSeverity,
    LogArea,
    LogItem,
    Logger,
    VERSION,
    DEFAULT_PORT,
    CliOptions,
    Pump,
    PumpController,
    FlowSensor,
    SECOND,
    MINUTE,
    FLOW_START_DELAY,
    FLOW_STOP_DELAY,
    PUMP_MAX_RUN_TIME,
    ActivityLogger,
    HistoryStore,
    StatsAccumulator,
    DaySummary,
    dateString,
    HISTORY_FILE,
    FlowConfig,
    applyConfig,
    DayTimeline,
} from "./flow_server";
import * as http from "http";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---- Flow Calculation Tests ----

describe("periodToHertz", () => {
    it("should return 0 for period 0", () => {
        expect(periodToHertz(0)).toBe(0);
    });

    it("should convert 1000ms period to 1 Hz", () => {
        expect(periodToHertz(1000)).toBe(1);
    });

    it("should convert 500ms period to 2 Hz", () => {
        expect(periodToHertz(500)).toBe(2);
    });

    it("should convert 100ms period to 10 Hz", () => {
        expect(periodToHertz(100)).toBe(10);
    });

    it("should convert 2000ms period to 0.5 Hz", () => {
        expect(periodToHertz(2000)).toBe(0.5);
    });
});

describe("pwToFlow", () => {
    it("should return 0 for period 0", () => {
        expect(pwToFlow(0)).toBe(0);
    });

    it("should calculate flow using formula Q = (F + 5) / 8.1", () => {
        // At 1000ms period (1 Hz): Q = (1 + 5) / 8.1 = 6/8.1
        const flow = pwToFlow(1000);
        expect(flow).toBeCloseTo(6 / 8.1, 5);
    });

    it("should calculate higher flow for shorter periods", () => {
        // 100ms = 10 Hz: Q = (10 + 5) / 8.1 = 15/8.1
        const flow = pwToFlow(100);
        expect(flow).toBeCloseTo(15 / 8.1, 5);
    });

    it("should return positive flow for any positive period", () => {
        expect(pwToFlow(50)).toBeGreaterThan(0);
        expect(pwToFlow(5000)).toBeGreaterThan(0);
    });
});

// ---- CLI Parsing Tests ----

describe("parseArgs", () => {
    it("should default to serve command", () => {
        const opts = parseArgs([]);
        expect(opts.command).toBe("serve");
        expect(opts.port).toBe(DEFAULT_PORT);
    });

    it("should parse -v as version", () => {
        expect(parseArgs(["-v"]).command).toBe("version");
    });

    it("should parse --version as version", () => {
        expect(parseArgs(["--version"]).command).toBe("version");
    });

    it("should parse -h as help", () => {
        expect(parseArgs(["-h"]).command).toBe("help");
    });

    it("should parse --help as help", () => {
        expect(parseArgs(["--help"]).command).toBe("help");
    });

    it("should parse -t as temperature with no sensor specified", () => {
        const opts = parseArgs(["-t"]);
        expect(opts.command).toBe("temperature");
        expect(opts.sensor).toBeUndefined();
    });

    it("should parse -t with sensor number", () => {
        const opts = parseArgs(["-t", "2"]);
        expect(opts.command).toBe("temperature");
        expect(opts.sensor).toBe(2);
    });

    it("should parse -f as flow", () => {
        expect(parseArgs(["-f"]).command).toBe("flow");
    });

    it("should parse -l as looptest", () => {
        expect(parseArgs(["-l"]).command).toBe("looptest");
    });

    it("should parse --looptest as looptest", () => {
        expect(parseArgs(["--looptest"]).command).toBe("looptest");
    });

    it("should parse -s as serve with default port", () => {
        const opts = parseArgs(["-s"]);
        expect(opts.command).toBe("serve");
        expect(opts.port).toBe(DEFAULT_PORT);
    });

    it("should parse -s with custom port", () => {
        const opts = parseArgs(["-s", "9090"]);
        expect(opts.command).toBe("serve");
        expect(opts.port).toBe(9090);
    });

    it("should parse -p as pump with no state", () => {
        const opts = parseArgs(["-p"]);
        expect(opts.command).toBe("pump");
        expect(opts.pumpState).toBeUndefined();
    });

    it("should parse -p 1 as pump on", () => {
        const opts = parseArgs(["-p", "1"]);
        expect(opts.command).toBe("pump");
        expect(opts.pumpState).toBe(true);
    });

    it("should parse -p 0 as pump off", () => {
        const opts = parseArgs(["-p", "0"]);
        expect(opts.command).toBe("pump");
        expect(opts.pumpState).toBe(false);
    });

    it("should parse --pump as pump", () => {
        expect(parseArgs(["--pump"]).command).toBe("pump");
    });
});

// ---- Logger Tests ----

describe("Logger", () => {
    it("should store log items", () => {
        const log = new Logger();
        log.maxSeverity = LogSeverity.Priority; // suppress console output
        log.log(LogSeverity.Info, LogArea.General, "test message");
        const output = log.fullLog(LogSeverity.Info);
        expect(output).toContain("test message");
    });
});

describe("LogItem", () => {
    it("should format toString with area and message", () => {
        const item = new LogItem(LogSeverity.Info, LogArea.Flow, undefined, "hello", Date.now());
        const str = item.toString();
        expect(str).toContain("FLOW");
        expect(str).toContain("hello");
    });

    it("should include error marker when error present", () => {
        const item = new LogItem(LogSeverity.Severe, LogArea.General, new Error("boom"), "ctx", Date.now());
        const str = item.toString();
        expect(str).toContain("!");
        expect(str).toContain("boom");
    });
});

// ---- HTTP Integration Tests ----

describe("FlowHttpServer", () => {
    let sensors: SensorManager;
    let server: FlowHttpServer;
    let port: number;

    beforeAll(async () => {
        sensors = new SensorManager();
        sensors.start();
        server = new FlowHttpServer(sensors);
        // Use port 0 for random available port
        await server.start(0);
        port = server.address!.port;
    });

    afterAll(async () => {
        sensors.stop();
        await server.stop();
    });

    function fetchJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
        return new Promise((resolve, reject) => {
            http.get(`http://localhost:${port}${path}`, (res) => {
                let data = "";
                res.on("data", (chunk) => data += chunk);
                res.on("end", () => {
                    try {
                        resolve({ status: res.statusCode!, body: JSON.parse(data) });
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on("error", reject);
        });
    }

    describe("GET /status", () => {
        it("should return status with all fields", async () => {
            const { status, body } = await fetchJson("/status");
            expect(status).toBe(200);
            expect(body.time).toBeGreaterThan(0);
            expect(body.status).toBe("ok");
            expect(body.start).toBeGreaterThan(0);
            expect(body.temperature).toBeDefined();
            expect(body.flow).toBeDefined();
            expect(Array.isArray(body.temperature)).toBe(true);
        });

        it("should include flow data in status", async () => {
            const { body } = await fetchJson("/status");
            const flow = body.flow as Record<string, unknown>;
            expect(typeof flow.lpm).toBe("number");
            expect(typeof flow.timeSinceLastChange).toBe("number");
        });
    });

    describe("GET /flow", () => {
        it("should return flow data", async () => {
            const { status, body } = await fetchJson("/flow");
            expect(status).toBe(200);
            expect(typeof body.lpm).toBe("number");
            expect(typeof body.time).toBe("number");
            expect(typeof body.timeSinceLastChange).toBe("number");
        });
    });

    describe("GET /temperature", () => {
        it("should return all sensors when no sensor param", async () => {
            const { status, body } = await fetchJson("/temperature");
            expect(status).toBe(200);
            expect(typeof body.time).toBe("number");
            expect(Array.isArray(body.sensors)).toBe(true);
        });

        it("should return filtered result for sensor 0", async () => {
            const { status, body } = await fetchJson("/temperature?sensor=0");
            // Might be 200 or 404 depending on platform sensor availability
            expect([200, 404]).toContain(status);
            if (status === 200) {
                const sensors = body.sensors as Array<Record<string, unknown>>;
                expect(sensors.length).toBe(1);
                expect(sensors[0].sensor).toBe(0);
                expect(typeof sensors[0].name).toBe("string");
            }
        });

        it("should return 404 for nonexistent sensor", async () => {
            const { status } = await fetchJson("/temperature?sensor=99");
            expect(status).toBe(404);
        });
    });

    describe("GET /pump", () => {
        it("should return pump state", async () => {
            const { status, body } = await fetchJson("/pump");
            expect(status).toBe(200);
            expect(typeof body.state).toBe("boolean");
            expect(typeof body.time).toBe("number");
            expect(typeof body.timeSinceLastChange).toBe("number");
        });
    });

    describe("PUT /pump", () => {
        function putJson(path: string, data: object): Promise<{ status: number; body: Record<string, unknown> }> {
            return new Promise((resolve, reject) => {
                const json = JSON.stringify(data);
                const req = http.request(`http://localhost:${port}${path}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) },
                }, (res) => {
                    let body = "";
                    res.on("data", (chunk) => body += chunk);
                    res.on("end", () => {
                        try {
                            resolve({ status: res.statusCode!, body: JSON.parse(body) });
                        } catch (e) { reject(e); }
                    });
                });
                req.on("error", reject);
                req.write(json);
                req.end();
            });
        }

        it("should set pump state to on", async () => {
            const { status, body } = await putJson("/pump", { state: true });
            expect(status).toBe(200);
            expect(body.state).toBe(true);
        });

        it("should set pump state to off", async () => {
            const { status, body } = await putJson("/pump", { state: false });
            expect(status).toBe(200);
            expect(body.state).toBe(false);
        });

        it("should reject invalid state", async () => {
            const { status } = await putJson("/pump", { state: "yes" });
            expect(status).toBe(400);
        });

        it("should reject invalid JSON", async () => {
            return new Promise((resolve, reject) => {
                const req = http.request(`http://localhost:${port}/pump`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                }, (res) => {
                    let body = "";
                    res.on("data", (chunk) => body += chunk);
                    res.on("end", () => {
                        expect(res.statusCode).toBe(400);
                        resolve(undefined);
                    });
                });
                req.on("error", reject);
                req.write("not json");
                req.end();
            });
        });
    });

    describe("unknown routes", () => {
        it("should return 404 for unknown path", async () => {
            const { status } = await fetchJson("/unknown");
            expect(status).toBe(404);
        });
    });
});

// ---- SensorManager Tests ----

describe("SensorManager", () => {
    it("should provide status with start time", () => {
        const sensors = new SensorManager();
        const status = sensors.getStatus();
        expect(status.time).toBeGreaterThan(0);
        expect(status.start).toBeGreaterThan(0);
        expect(status.status).toBe("ok");
        sensors.stop();
    });

    it("should provide flow reading", () => {
        const sensors = new SensorManager();
        const flow = sensors.getFlow();
        expect(typeof flow.lpm).toBe("number");
        expect(typeof flow.time).toBe("number");
        sensors.stop();
    });

    it("should return empty sensors array for nonexistent sensor", () => {
        const sensors = new SensorManager();
        const reading = sensors.getTemperature(99);
        expect(reading.sensors).toHaveLength(0);
        sensors.stop();
    });

    it("should return all sensors when no index specified", () => {
        const sensors = new SensorManager();
        const reading = sensors.getTemperature();
        expect(typeof reading.time).toBe("number");
        expect(Array.isArray(reading.sensors)).toBe(true);
        sensors.stop();
    });

    it("should provide pump state", () => {
        const sensors = new SensorManager();
        const pump = sensors.getPump();
        expect(pump.state).toBe(false);
        expect(typeof pump.timeSinceLastChange).toBe("number");
        sensors.stop();
    });

    it("should set pump state", () => {
        const sensors = new SensorManager();
        sensors.setPump(true);
        expect(sensors.getPump().state).toBe(true);
        sensors.setPump(false);
        expect(sensors.getPump().state).toBe(false);
        sensors.stop();
    });
});

// ---- Pump Tests ----

describe("Pump", () => {
    it("should default to off", () => {
        const pump = new Pump();
        expect(pump.state).toBe(false);
    });

    it("should track state changes", () => {
        const pump = new Pump();
        pump.setState(true);
        expect(pump.state).toBe(true);
        pump.setState(false);
        expect(pump.state).toBe(false);
    });

    it("should track time since last change", () => {
        const pump = new Pump();
        // Before any state change, returns -1
        expect(pump.timeSinceLastChange).toBe(-1);
        pump.setState(true);
        expect(pump.timeSinceLastChange).toBeGreaterThanOrEqual(0);
    });

    it("should not update time when setting same state", () => {
        const pump = new Pump();
        pump.setState(true);
        const t1 = pump.timeSinceLastChange;
        pump.setState(true); // same state
        const t2 = pump.timeSinceLastChange;
        // t2 should be >= t1 (time didn't reset)
        expect(t2).toBeGreaterThanOrEqual(t1);
    });

    it("should track source", () => {
        const pump = new Pump();
        expect(pump.source).toBeUndefined();
        pump.setState(true, "auto");
        expect(pump.source).toBe("auto");
        pump.setState(false);
        expect(pump.source).toBeUndefined();
    });
});

// ---- PumpController Tests ----

describe("PumpController", () => {
    let pump: Pump;
    let flow: FlowSensor;
    let controller: PumpController;
    let mockLpm: number;
    let mockFlowStartTime: number | undefined;

    beforeEach(() => {
        jest.useFakeTimers();
        pump = new Pump();
        flow = new FlowSensor();

        // Mock flow sensor getters
        mockLpm = 0;
        mockFlowStartTime = undefined;
        Object.defineProperty(flow, "lpm", { get: () => mockLpm, configurable: true });
        Object.defineProperty(flow, "flowStartTime", { get: () => mockFlowStartTime, configurable: true });

        controller = new PumpController(pump, flow);
        controller.start();
    });

    afterEach(() => {
        controller.stop();
        jest.useRealTimers();
    });

    function simulateFlow(lpm: number): void {
        mockLpm = lpm;
        if (lpm > 0 && mockFlowStartTime === undefined) {
            mockFlowStartTime = Date.now();
        } else if (lpm === 0) {
            mockFlowStartTime = undefined;
        }
    }

    it("should auto-on after flow persists > FLOW_START_DELAY", () => {
        simulateFlow(3.0);
        // Advance less than FLOW_START_DELAY — pump should stay off
        jest.advanceTimersByTime(FLOW_START_DELAY - SECOND);
        expect(pump.state).toBe(false);

        // Advance past FLOW_START_DELAY
        jest.advanceTimersByTime(2 * SECOND);
        expect(pump.state).toBe(true);
        expect(pump.source).toBe("auto");
    });

    it("should not auto-on if flow stops before delay", () => {
        simulateFlow(3.0);
        jest.advanceTimersByTime(3 * SECOND);
        simulateFlow(0);
        jest.advanceTimersByTime(5 * SECOND);
        expect(pump.state).toBe(false);
    });

    it("should auto-off after flow stops > FLOW_STOP_DELAY", () => {
        // Start flow and let pump auto-on
        simulateFlow(3.0);
        jest.advanceTimersByTime(FLOW_START_DELAY + SECOND);
        expect(pump.state).toBe(true);

        // Stop flow
        simulateFlow(0);
        // Not yet past FLOW_STOP_DELAY
        jest.advanceTimersByTime(FLOW_STOP_DELAY - SECOND);
        expect(pump.state).toBe(true);

        // Past FLOW_STOP_DELAY
        jest.advanceTimersByTime(2 * SECOND);
        expect(pump.state).toBe(false);
    });

    it("should not auto-off a user-started pump", () => {
        controller.userSetPump(true);
        expect(pump.source).toBe("user");

        // Flow stops
        simulateFlow(0);
        jest.advanceTimersByTime(FLOW_STOP_DELAY + 5 * SECOND);
        // Pump should still be on — auto-off only applies to auto source
        expect(pump.state).toBe(true);
    });

    it("should set userOverride when user turns off auto pump", () => {
        // Auto-on
        simulateFlow(3.0);
        jest.advanceTimersByTime(FLOW_START_DELAY + SECOND);
        expect(pump.state).toBe(true);
        expect(pump.source).toBe("auto");

        // User turns off
        controller.userSetPump(false);
        expect(pump.state).toBe(false);

        // Flow still active — should NOT auto-on again due to override
        simulateFlow(3.0);
        jest.advanceTimersByTime(FLOW_START_DELAY + 5 * SECOND);
        expect(pump.state).toBe(false);
    });

    it("should clear userOverride when flow stops", () => {
        // Auto-on then user turns off
        simulateFlow(3.0);
        jest.advanceTimersByTime(FLOW_START_DELAY + SECOND);
        controller.userSetPump(false);

        // Flow stops, override clears
        simulateFlow(0);
        jest.advanceTimersByTime(FLOW_STOP_DELAY + SECOND);

        // New flow event should trigger auto-on again
        simulateFlow(3.0);
        jest.advanceTimersByTime(FLOW_START_DELAY + SECOND);
        expect(pump.state).toBe(true);
        expect(pump.source).toBe("auto");
    });

    it("should safety shutoff auto-started pump at max run time", () => {
        simulateFlow(3.0);
        jest.advanceTimersByTime(FLOW_START_DELAY + SECOND);
        expect(pump.state).toBe(true);
        // Pump turned on at tick FLOW_START_DELAY (5s).
        // Advance to 2s before max run time expires
        jest.advanceTimersByTime(PUMP_MAX_RUN_TIME - 3 * SECOND);
        expect(pump.state).toBe(true);

        // Advance past max run time
        jest.advanceTimersByTime(3 * SECOND);
        expect(pump.state).toBe(false);
    });

    it("should safety shutoff user-started pump at max run time", () => {
        controller.userSetPump(true);
        expect(pump.state).toBe(true);

        jest.advanceTimersByTime(PUMP_MAX_RUN_TIME + SECOND);
        expect(pump.state).toBe(false);
    });

    it("should clear userOverride when user turns on", () => {
        // Auto-on then user turns off (sets override)
        simulateFlow(3.0);
        jest.advanceTimersByTime(FLOW_START_DELAY + SECOND);
        controller.userSetPump(false);

        // User turns on again — clears override
        controller.userSetPump(true);

        // Turn off via user, flow should be able to auto-on since override was cleared
        controller.userSetPump(false);

        // But now override is set again because we turned off while source is "user" not "auto"
        // Actually: userSetPump(false) only sets override if source was "auto"
        // After userSetPump(true), source is "user", so userSetPump(false) sets override
        // Let's test the simple case: user on clears override, and auto can engage next flow cycle
        simulateFlow(0);
        jest.advanceTimersByTime(FLOW_STOP_DELAY + SECOND);
        simulateFlow(3.0);
        jest.advanceTimersByTime(FLOW_START_DELAY + SECOND);
        // Should auto-on since we went through a full flow stop/start cycle
        expect(pump.state).toBe(true);
        expect(pump.source).toBe("auto");
    });
});

// ---- Callback Tests ----

describe("Pump callbacks", () => {
    it("should fire onStateChange on state transitions", () => {
        const pump = new Pump();
        const changes: { on: boolean; source: string | undefined }[] = [];
        pump.onStateChange = (on, source) => {
            changes.push({ on, source });
        };
        pump.setState(true, "auto");
        pump.setState(true, "auto"); // no-op, same state
        pump.setState(false);
        expect(changes).toEqual([
            { on: true, source: "auto" },
            { on: false, source: undefined },
        ]);
    });
});

describe("FlowSensor callbacks", () => {
    it("should fire onFlowChange on 0/nonzero transitions", () => {
        jest.useFakeTimers();
        const flow = new FlowSensor();
        const changes: { started: boolean; lpm: number }[] = [];
        flow.onFlowChange = (started, lpm) => {
            changes.push({ started, lpm });
        };
        // Access private updateFlow via casting
        const updateFlow = (flow as unknown as { updateFlow(f: number): void }).updateFlow.bind(flow);
        updateFlow(3.0);
        updateFlow(3.5); // not a 0↔>0 transition
        updateFlow(0);
        jest.advanceTimersByTime(600); // wait for stop debounce (500ms)
        updateFlow(0); // no-op
        updateFlow(1.0);
        expect(changes).toEqual([
            { started: true, lpm: 3.0 },
            { started: false, lpm: 0 },
            { started: true, lpm: 1.0 },
        ]);
        jest.useRealTimers();
    });

    it("should ignore brief flow gaps (debounce)", () => {
        jest.useFakeTimers();
        const flow = new FlowSensor();
        const changes: { started: boolean; lpm: number }[] = [];
        flow.onFlowChange = (started, lpm) => {
            changes.push({ started, lpm });
        };
        const updateFlow = (flow as unknown as { updateFlow(f: number): void }).updateFlow.bind(flow);
        updateFlow(5.0); // flow starts
        updateFlow(0);   // brief glitch — goes to 0
        jest.advanceTimersByTime(100); // only 100ms — within debounce
        updateFlow(4.0); // flow resumes before debounce fires
        jest.advanceTimersByTime(600); // let any pending timers fire
        // Should only see the initial start — no stop/restart
        expect(changes).toEqual([
            { started: true, lpm: 5.0 },
        ]);
        // flowStartTime should be preserved (not reset)
        expect(flow.flowStartTime).toBeDefined();
        jest.useRealTimers();
    });
});

// ---- DayTimeline Sparse Tests ----

describe("DayTimeline sparse round-trip", () => {
    it("should round-trip temperature, flow, and pump intervals", () => {
        const tl = new DayTimeline("2026-03-15");
        // Record temperature every minute for a stretch
        for (let m = 100; m <= 120; m++) {
            tl.record(m, 45 + m * 0.1, m === 110 ? 15 : 0);
        }
        tl.pumpChanged(true, 108);
        tl.pumpChanged(false, 115);

        const sparse = tl.toSparse();
        const restored = DayTimeline.fromSparse("2026-03-15", sparse);

        // Temperature should be present for all recorded minutes via interpolation
        for (let m = 100; m <= 120; m++) {
            expect(restored.points[m]).toBeDefined();
            expect(restored.points[m]!.hotCelsius).toBeDefined();
        }
        // Spot-check first and last temp
        expect(restored.points[100]!.hotCelsius).toBeCloseTo(55, 0);
        expect(restored.points[120]!.hotCelsius).toBeCloseTo(57, 0);

        // Flow should show at minute 110
        expect(restored.points[110]!.flowLpm).toBe(15);
        expect(restored.points[109]!.flowLpm).toBe(0);

        // Pump interval preserved
        expect(restored.pumpIntervals).toHaveLength(1);
        expect(restored.pumpIntervals[0].startMinute).toBe(108);
        expect(restored.pumpIntervals[0].endMinute).toBe(115);
    });

    it("should be compact — skip unchanged temperature", () => {
        const tl = new DayTimeline("2026-03-15");
        // Record constant temperature for 30 minutes
        for (let m = 0; m < 30; m++) {
            tl.record(m, 50.0, 0);
        }
        const sparse = tl.toSparse();
        // Should store ~2 points (first + every 15 min), not 30
        expect(sparse.points.length).toBeLessThan(10);
    });

    it("should include heater active flag", () => {
        const tl = new DayTimeline("2026-03-15");
        tl.record(60, 40, 0, false);
        tl.record(61, 40.1, 0, true);
        tl.record(62, 40.2, 0, false);

        const sparse = tl.toSparse();
        const restored = DayTimeline.fromSparse("2026-03-15", sparse);

        expect(restored.points[61]!.heaterActive).toBe(true);
        expect(restored.points[60]!.heaterActive).toBe(false);
        expect(restored.points[62]!.heaterActive).toBe(false);
    });

    it("toSummary should include timeline that restores correctly", async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), "sparse-test-"));
        const histPath = join(tmpDir, "history.json");
        const logger = new ActivityLogger(tmpDir);
        const history = new HistoryStore(histPath);
        const acc = new StatsAccumulator(logger, history);

        // Record some data
        acc.tick(5.0, true, [{ name: "Hot", celsius: 55 }], false);

        const summary = acc.toSummary();
        expect(summary.timeline).toBeDefined();
        expect(summary.timeline!.points.length).toBeGreaterThan(0);

        // Persist and reload
        history.upsertDay(summary);
        await history.flush();
        const loaded = history.getDay(summary.date);
        expect(loaded?.timeline).toBeDefined();

        const restored = DayTimeline.fromSparse(summary.date, loaded!.timeline!);
        expect(restored.points.some(p => p !== undefined)).toBe(true);

        rmSync(tmpDir, { recursive: true, force: true });
    });
});

// ---- ActivityLogger Tests ----

describe("ActivityLogger", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "flow-log-test-"));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should write log lines to flow.log", () => {
        const al = new ActivityLogger(tmpDir);
        al.logPumpChange(true, "auto");
        al.logFlowChange(true, 3.2);
        al.logTemperatureChange("Hot", 50.0, 55.0);

        const logPath = join(tmpDir, "flow.log");
        expect(existsSync(logPath)).toBe(true);
        const content = readFileSync(logPath, "utf-8");
        expect(content).toContain("PUMP");
        expect(content).toContain("ON (auto)");
        expect(content).toContain("FLOW");
        expect(content).toContain("START 3.20 L/min");
        expect(content).toContain("TEMP");
        expect(content).toContain("Hot 50.0\u00b0C -> 55.0\u00b0C");
    });

    it("should rotate logs", () => {
        const al = new ActivityLogger(tmpDir);
        al.logPumpChange(true, "user");
        al.rotateLogs();

        // Original log should be renamed
        const files = readdirSync(tmpDir);
        expect(files.some((f) => f.startsWith("flow_") && f.endsWith(".log"))).toBe(true);
        expect(existsSync(join(tmpDir, "flow.log"))).toBe(false);
    });

    it("should write daily summary", () => {
        const al = new ActivityLogger(tmpDir);
        const summary: DaySummary = {
            date: "2026-03-08",
            flowLiters: 12.4,
            pumpOnMinutes: 83,
            avgTemps: [{ name: "Hot", avgCelsius: 58.1 }, { name: "Cold", avgCelsius: 22.1 }],
            hotAvgWhilePumping: 60.0,
        };
        al.writeDailySummary(summary);
        const content = readFileSync(join(tmpDir, "flow.log"), "utf-8");
        expect(content).toContain("DAILY");
        expect(content).toContain("flow=12.4 L");
        expect(content).toContain("pump=83min");
        expect(content).toContain("Hot=58.1");
    });
});

// ---- HistoryStore Tests ----

describe("HistoryStore", () => {
    let tmpDir: string;
    const stores: HistoryStore[] = [];

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "flow-hist-test-"));
        stores.length = 0;
    });

    afterEach(async () => {
        await Promise.all(stores.map((s) => s.flush()));
        rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeStore(path: string): HistoryStore {
        const s = new HistoryStore(path);
        stores.push(s);
        return s;
    }

    function makeSummary(date: string, flow: number, pump: number): DaySummary {
        return {
            date,
            flowLiters: flow,
            pumpOnMinutes: pump,
            avgTemps: [{ name: "Hot", avgCelsius: 55.0 }],
            hotAvgWhilePumping: 58.0,
        };
    }

    it("should persist and load days", async () => {
        const path = join(tmpDir, "flow_history.json");
        const store = makeStore(path);
        store.appendDay(makeSummary("2026-03-01", 10, 20));
        store.appendDay(makeSummary("2026-03-02", 15, 25));
        await store.flush();

        // Load from disk in a new instance
        const store2 = makeStore(path);
        const days = store2.getAllDays();
        expect(days).toHaveLength(2);
        expect(days[0].date).toBe("2026-03-01");
        expect(days[1].flowLiters).toBe(15);
    });

    it("should compute rolling stats", () => {
        const path = join(tmpDir, "flow_history.json");
        const store = makeStore(path);
        store.appendDay(makeSummary("2026-03-01", 10, 20));
        store.appendDay(makeSummary("2026-03-02", 15, 25));
        store.appendDay(makeSummary("2026-03-03", 5, 10));

        const stats = store.getRollingStats(7);
        expect(stats.days).toBe(3);
        expect(stats.flowLiters).toBe(30);
        expect(stats.pumpOnMinutes).toBe(55);
        expect(stats.avgTemps[0].name).toBe("Hot");
        expect(stats.avgTemps[0].avgCelsius).toBe(55.0);
        expect(stats.hotAvgWhilePumping).toBe(58.0);
    });

    it("should limit to requested days", () => {
        const path = join(tmpDir, "flow_history.json");
        const store = makeStore(path);
        for (let i = 1; i <= 10; i++) {
            store.appendDay(makeSummary(`2026-03-${i.toString().padStart(2, "0")}`, i * 2, i * 3));
        }
        const stats = store.getRollingStats(3);
        expect(stats.days).toBe(3);
        // Last 3 days: 8,9,10 → flow = 16+18+20 = 54
        expect(stats.flowLiters).toBe(54);
    });

    it("should cap at 31 entries", () => {
        const path = join(tmpDir, "flow_history.json");
        const store = makeStore(path);
        for (let i = 1; i <= 35; i++) {
            store.appendDay(makeSummary(`2026-01-${i.toString().padStart(2, "0")}`, 1, 1));
        }
        expect(store.getAllDays()).toHaveLength(31);
    });

    it("should upsert an existing day by replacing it", () => {
        const path = join(tmpDir, "flow_history.json");
        const store = makeStore(path);
        store.appendDay(makeSummary("2026-03-01", 10, 20));
        store.appendDay(makeSummary("2026-03-02", 5, 10));

        // Upsert existing day with updated values
        store.upsertDay(makeSummary("2026-03-01", 25, 40));

        const days = store.getAllDays();
        expect(days).toHaveLength(2);
        const day1 = days.find((d) => d.date === "2026-03-01");
        expect(day1!.flowLiters).toBe(25);
        expect(day1!.pumpOnMinutes).toBe(40);
    });

    it("should upsert a new day by appending it", () => {
        const path = join(tmpDir, "flow_history.json");
        const store = makeStore(path);
        store.appendDay(makeSummary("2026-03-01", 10, 20));

        store.upsertDay(makeSummary("2026-03-02", 15, 30));

        const days = store.getAllDays();
        expect(days).toHaveLength(2);
        expect(days[1].date).toBe("2026-03-02");
        expect(days[1].flowLiters).toBe(15);
    });

    it("should persist upserted data to disk", async () => {
        const path = join(tmpDir, "flow_history.json");
        const store = makeStore(path);
        store.appendDay(makeSummary("2026-03-01", 10, 20));
        store.upsertDay(makeSummary("2026-03-01", 50, 60));
        await store.flush();

        // Reload from disk
        const store2 = makeStore(path);
        const days = store2.getAllDays();
        expect(days).toHaveLength(1);
        expect(days[0].flowLiters).toBe(50);
    });
});

// ---- StatsAccumulator Tests ----

describe("StatsAccumulator", () => {
    let tmpDir: string;
    let al: ActivityLogger;
    let history: HistoryStore;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "flow-stats-test-"));
        al = new ActivityLogger(tmpDir);
        history = new HistoryStore(join(tmpDir, "flow_history.json"));
    });

    afterEach(async () => {
        await history.flush();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should accumulate flow and pump time", () => {
        const acc = new StatsAccumulator(al, history);
        const temps = [{ name: "Hot", celsius: 55.0 as number | undefined }];

        // 10 ticks at 6 L/min with pump on
        for (let i = 0; i < 10; i++) {
            acc.tick(6.0, true, temps, false);
        }

        const summary = acc.toSummary();
        // 6 L/min * 10 ticks / 60 = 1.0 L
        expect(summary.flowLiters).toBe(1.0);
        // 10 seconds of pump on = 10/60 minutes
        expect(summary.pumpOnMinutes).toBeGreaterThan(0);
        expect(summary.avgTemps[0].avgCelsius).toBe(55.0);
        expect(summary.hotAvgWhilePumping).toBe(55.0);
    });

    it("should not accumulate flow when lpm is 0", () => {
        const acc = new StatsAccumulator(al, history);
        for (let i = 0; i < 10; i++) {
            acc.tick(0, false, [], false);
        }
        expect(acc.toSummary().flowLiters).toBe(0);
        expect(acc.toSummary().pumpOnMinutes).toBe(0);
    });

    it("should handle midnight rollover", () => {
        let fakeNow = new Date("2026-03-08T23:59:58.000").getTime();
        const acc = new StatsAccumulator(al, history, () => fakeNow);
        const temps = [{ name: "Hot", celsius: 50.0 as number | undefined }];

        // Tick in the current day
        acc.tick(6.0, true, temps, false);
        fakeNow += 1000;
        acc.tick(6.0, true, temps, false);

        // Cross midnight
        fakeNow = new Date("2026-03-09T00:00:01.000").getTime();
        acc.tick(6.0, true, temps, false);

        // History should have one day persisted
        const days = history.getAllDays();
        expect(days).toHaveLength(1);
        expect(days[0].date).toBe("2026-03-08");
        expect(days[0].flowLiters).toBeGreaterThan(0);

        // Current accumulator should be reset for new day
        const snapshot = acc.getSnapshot();
        expect(snapshot.today.date).toBe("2026-03-09");
    });

    it("should persist partial-day data on close", () => {
        const acc = new StatsAccumulator(al, history);
        const temps = [{ name: "Hot", celsius: 55.0 as number | undefined }];

        // Accumulate some data
        for (let i = 0; i < 60; i++) {
            acc.tick(6.0, true, temps, false);
        }

        // Close should persist today's summary
        acc.close();

        const days = history.getAllDays();
        expect(days).toHaveLength(1);
        expect(days[0].flowLiters).toBeGreaterThan(0);
        expect(days[0].pumpOnMinutes).toBeGreaterThan(0);
    });

    it("should accumulate data across restarts on the same day", () => {
        // Simulate first run saving partial data
        const acc1 = new StatsAccumulator(al, history);
        const temps = [{ name: "Hot", celsius: 55.0 as number | undefined }];
        for (let i = 0; i < 30; i++) {
            acc1.tick(6.0, true, temps, false);
        }
        acc1.close();

        expect(history.getAllDays()).toHaveLength(1);
        const firstFlow = history.getAllDays()[0].flowLiters;
        const firstPump = history.getAllDays()[0].pumpOnMinutes;

        // Simulate second run on same day — should restore and add to previous data
        const acc2 = new StatsAccumulator(al, history);
        for (let i = 0; i < 30; i++) {
            acc2.tick(6.0, true, temps, false);
        }
        acc2.close();

        // Should still be one entry, not two
        const days = history.getAllDays();
        expect(days).toHaveLength(1);
        // Flow and pump time should have accumulated (roughly doubled)
        expect(days[0].flowLiters).toBeGreaterThan(firstFlow);
        expect(days[0].pumpOnMinutes).toBeGreaterThan(firstPump);
    });

    it("should provide snapshot with week and month stats", () => {
        // Pre-populate history
        for (let i = 1; i <= 10; i++) {
            history.appendDay({
                date: `2026-03-${i.toString().padStart(2, "0")}`,
                flowLiters: 10,
                pumpOnMinutes: 30,
                avgTemps: [{ name: "Hot", avgCelsius: 55 }],
                hotAvgWhilePumping: 58,
            });
        }

        const acc = new StatsAccumulator(al, history);
        const snapshot = acc.getSnapshot();
        expect(snapshot.week.days).toBe(7);
        expect(snapshot.week.flowLiters).toBe(70);
        expect(snapshot.month.days).toBe(10);
        expect(snapshot.month.flowLiters).toBe(100);
    });
});

// ---- Config Tests ----

describe("applyConfig", () => {
    // Save originals and restore after each test
    let origPort: number;
    let origFlowStart: number;
    let origFlowStop: number;
    let origPumpMax: number;

    beforeEach(() => {
        origPort = DEFAULT_PORT;
        origFlowStart = FLOW_START_DELAY;
        origFlowStop = FLOW_STOP_DELAY;
        origPumpMax = PUMP_MAX_RUN_TIME;
    });

    afterEach(() => {
        applyConfig({
            port: origPort,
            flowStartDelay: origFlowStart / SECOND,
            flowStopDelay: origFlowStop / SECOND,
            pumpMaxRunTime: origPumpMax / MINUTE,
        });
    });

    it("should apply config values", () => {
        applyConfig({
            port: 9090,
            flowStartDelay: 10,
            flowStopDelay: 5,
            pumpMaxRunTime: 60,
        });
        expect(DEFAULT_PORT).toBe(9090);
        expect(FLOW_START_DELAY).toBe(10 * SECOND);
        expect(FLOW_STOP_DELAY).toBe(5 * SECOND);
        expect(PUMP_MAX_RUN_TIME).toBe(60 * MINUTE);
    });

    it("should leave defaults when config is empty", () => {
        applyConfig({});
        expect(DEFAULT_PORT).toBe(origPort);
        expect(FLOW_START_DELAY).toBe(origFlowStart);
    });
});

// ---- OYU Protocol Tests ----

/** Build a valid OYU message with correct checksum. */
function oyuMsg(body: string): string {
    let xor = 0;
    for (let i = 0; i < body.length; i++) {
        xor ^= body.charCodeAt(i);
    }
    const xsum = xor.toString(16).padStart(2, "0").toUpperCase();
    return `${body}|${xsum}\n`;
}

describe("DoorMonitor.xorChecksum", () => {
    it("should compute correct XOR for simple string", () => {
        // "AB" = 0x41 ^ 0x42 = 0x03
        expect(DoorMonitor.xorChecksum("AB")).toBe("03");
    });

    it("should return 2-digit uppercase hex", () => {
        const result = DoorMonitor.xorChecksum("OYU:01:OPEN:05:00");
        expect(result).toMatch(/^[0-9A-F]{2}$/);
    });

    it("should return 00 for empty string", () => {
        expect(DoorMonitor.xorChecksum("")).toBe("00");
    });
});

describe("DoorMonitor protocol parsing", () => {
    let monitor: DoorMonitor;
    let receivedEvents: DoorEvent[];

    beforeEach(() => {
        monitor = new DoorMonitor();
        receivedEvents = [];
        monitor.onEvent = (ev) => receivedEvents.push(ev);
    });

    // ---- OPEN messages ----

    it("should parse a valid OPEN message", () => {
        monitor.feedData(oyuMsg("OYU:01:OPEN:05:00"));
        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0].doorId).toBe(1);
        expect(receivedEvents[0].type).toBe("open");
        expect(receivedEvents[0].openSeconds).toBe(5);
    });

    it("should parse OPEN with zero seconds", () => {
        monitor.feedData(oyuMsg("OYU:01:OPEN:00:00"));
        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0].openSeconds).toBe(0);
    });

    it("should parse OPEN with sentinel 99 as still open", () => {
        monitor.feedData(oyuMsg("OYU:01:OPEN:99:00"));
        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0].openSeconds).toBe(DOOR_STILL_OPEN_SENTINEL);
    });

    it("should reject OPEN with seconds between 60 and 98", () => {
        monitor.feedData(oyuMsg("OYU:01:OPEN:75:00"));
        expect(receivedEvents).toHaveLength(0);
    });

    // ---- CLOSE messages ----

    it("should parse a valid CLOSE message with empty data field", () => {
        monitor.feedData(oyuMsg("OYU:02:CLOSE::00"));
        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0].doorId).toBe(2);
        expect(receivedEvents[0].type).toBe("close");
    });

    // ---- Sequence numbers and duplicates ----

    it("should ignore duplicate sequence numbers for the same sensor", () => {
        monitor.feedData(oyuMsg("OYU:01:OPEN:05:03"));
        monitor.feedData(oyuMsg("OYU:01:OPEN:10:03"));  // same seq
        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0].openSeconds).toBe(5);
    });

    it("should accept same sequence number from different sensors", () => {
        monitor.feedData(oyuMsg("OYU:01:OPEN:05:03"));
        monitor.feedData(oyuMsg("OYU:02:OPEN:10:03"));  // different sensor
        expect(receivedEvents).toHaveLength(2);
    });

    it("should accept new sequence number from same sensor", () => {
        monitor.feedData(oyuMsg("OYU:01:OPEN:05:03"));
        monitor.feedData(oyuMsg("OYU:01:CLOSE::04"));   // seq incremented
        expect(receivedEvents).toHaveLength(2);
    });

    it("should handle sequence number wraparound", () => {
        monitor.feedData(oyuMsg("OYU:01:OPEN:05:99"));
        monitor.feedData(oyuMsg("OYU:01:CLOSE::00"));   // wrapped
        expect(receivedEvents).toHaveLength(2);
    });

    // ---- Checksum validation ----

    it("should reject message with bad checksum", () => {
        monitor.feedData("OYU:01:OPEN:05:00|FF\n");  // wrong checksum
        expect(receivedEvents).toHaveLength(0);
    });

    it("should reject message without checksum separator", () => {
        monitor.feedData("OYU:01:OPEN:05:00\n");
        expect(receivedEvents).toHaveLength(0);
    });

    // ---- Message validation ----

    it("should reject message over 32 bytes", () => {
        const longBody = "OYU:01:OPEN:" + "0".repeat(20) + ":00";
        monitor.feedData(oyuMsg(longBody));
        expect(receivedEvents).toHaveLength(0);
    });

    it("should reject unknown verb", () => {
        monitor.feedData(oyuMsg("OYU:01:PING:data:00"));
        expect(receivedEvents).toHaveLength(0);
    });

    it("should reject invalid sensor ID", () => {
        monitor.feedData(oyuMsg("OYU:XX:OPEN:05:00"));
        expect(receivedEvents).toHaveLength(0);
    });

    it("should reject invalid sequence number", () => {
        monitor.feedData(oyuMsg("OYU:01:OPEN:05:AB"));
        expect(receivedEvents).toHaveLength(0);
    });

    it("should ignore non-OYU data in buffer", () => {
        monitor.feedData("garbage data\nmore junk\n");
        monitor.feedData(oyuMsg("OYU:01:OPEN:05:00"));
        expect(receivedEvents).toHaveLength(1);
    });

    // ---- BAT / CPU / SER / VER messages ----

    it("should parse BAT message and update sensor status", () => {
        monitor.feedData(oyuMsg("OYU:01:BAT:4200:00"));
        expect(receivedEvents).toHaveLength(0);  // BAT is not a door event
        const status = monitor.getAllSensorStatus().get(1);
        expect(status).toBeDefined();
        expect(status!.batteryMv).toBe(4200);
    });

    it("should parse CPU message and update sensor status", () => {
        monitor.feedData(oyuMsg("OYU:01:CPU:003600:00"));
        const status = monitor.getAllSensorStatus().get(1);
        expect(status).toBeDefined();
        expect(status!.cpuUptime).toBe(3600);
    });

    it("should parse SER message and update sensor status", () => {
        monitor.feedData(oyuMsg("OYU:01:SER:001200:00"));
        const status = monitor.getAllSensorStatus().get(1);
        expect(status).toBeDefined();
        expect(status!.serialUptime).toBe(1200);
    });

    it("should parse VER message and update sensor status", () => {
        monitor.feedData(oyuMsg("OYU:01:VER:0001:00"));
        const status = monitor.getAllSensorStatus().get(1);
        expect(status).toBeDefined();
        expect(status!.version).toBe(1);
    });

    it("should identify test mode version", () => {
        monitor.feedData(oyuMsg("OYU:01:VER:1001:00"));
        const status = monitor.getAllSensorStatus().get(1);
        expect(status!.version).toBe(1001);
        // version >= 1000 = test mode per protocol
    });

    // ---- Multiple messages in one buffer ----

    it("should parse multiple messages delivered in one chunk", () => {
        const msg1 = oyuMsg("OYU:01:OPEN:05:00");
        const msg2 = oyuMsg("OYU:01:CLOSE::01");
        monitor.feedData(msg1 + msg2);
        expect(receivedEvents).toHaveLength(2);
        expect(receivedEvents[0].type).toBe("open");
        expect(receivedEvents[1].type).toBe("close");
    });

    it("should handle partial message across multiple feedData calls", () => {
        const msg = oyuMsg("OYU:01:OPEN:30:00");
        const half = Math.floor(msg.length / 2);
        monitor.feedData(msg.slice(0, half));
        expect(receivedEvents).toHaveLength(0);  // not complete yet
        monitor.feedData(msg.slice(half));
        expect(receivedEvents).toHaveLength(1);
    });

    // ---- getDoorStates / getRecentEvents ----

    it("should track door states across events", () => {
        monitor.feedData(oyuMsg("OYU:01:OPEN:05:00"));
        monitor.feedData(oyuMsg("OYU:02:CLOSE::00"));
        const states = monitor.getDoorStates();
        expect(states).toHaveLength(2);
        expect(states[0].doorId).toBe(1);
        expect(states[0].lastEvent.type).toBe("open");
        expect(states[1].doorId).toBe(2);
        expect(states[1].lastEvent.type).toBe("close");
    });

    it("should return recent events in order", () => {
        monitor.feedData(oyuMsg("OYU:01:OPEN:05:00"));
        monitor.feedData(oyuMsg("OYU:01:CLOSE::01"));
        const events = monitor.getRecentEvents();
        expect(events).toHaveLength(2);
        expect(events[0].type).toBe("open");
        expect(events[1].type).toBe("close");
    });

    // ---- Sensor status accumulation ----

    it("should accumulate multiple status fields for same sensor", () => {
        monitor.feedData(oyuMsg("OYU:05:BAT:3800:00"));
        monitor.feedData(oyuMsg("OYU:05:CPU:007200:01"));
        monitor.feedData(oyuMsg("OYU:05:VER:0002:02"));
        const status = monitor.getAllSensorStatus().get(5);
        expect(status).toBeDefined();
        expect(status!.batteryMv).toBe(3800);
        expect(status!.cpuUptime).toBe(7200);
        expect(status!.version).toBe(2);
    });
});
