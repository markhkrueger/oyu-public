"strict";

import { createServer, IncomingMessage, ServerResponse, Server } from "http";
// url module no longer used — replaced by WHATWG URL API
import {
    appendFileSync, readFileSync, writeFileSync, existsSync,
    renameSync, readdirSync, unlinkSync, statSync, mkdirSync
} from "fs";
import { writeFile, rename, stat } from "fs/promises";
import { join, dirname } from "path";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import { spawn, spawnSync, execSync, ChildProcess } from "child_process";
import { uptime as osUptime, freemem, totalmem, hostname, networkInterfaces as osNetworkInterfaces } from "os";
import {
    Accessory, Bridge, Service, Characteristic,
    uuid, Categories, CharacteristicValue,
} from "@homebridge/hap-nodejs";
import QRCode = require("qrcode");
import * as si from 'systeminformation';

/*

Flow Server - HTTP server for Raspberry Pi sensor data.

Runs on a Raspberry Pi with a Hall Effect flow sensor and DS18B20 temperature
sensors. Instead of pushing data to a control server, this acts as an HTTP
server that the control server can poll for current readings.

Endpoints:
  GET /status        - overall status with all sensor readings
  GET /temperature?sensor=N - reading from temperature sensor N
  GET /flow          - current flow reading

(c) 2022-2026 Mark Krueger

*/

const VERSION = "1.0.8";

// ---- Constants ----

const MINUTE_SECONDS = 60;
const SECOND = 1000;
const MINUTE = MINUTE_SECONDS * SECOND;
const HOUR = MINUTE_SECONDS * MINUTE;

const CONFIG_FILE = "flow_config.json";

let DEFAULT_PORT = 8080;
let TEMP_POLL_INTERVAL = 10 * SECOND;
let FLOW_POLL_INTERVAL = 1 * SECOND;

let FLOW_START_DELAY = 5 * SECOND;   // flow must persist before auto-on
let FLOW_STOP_DELAY = 3 * SECOND;    // flow must stop before auto-off
let PUMP_MAX_RUN_TIME = 30 * MINUTE; // absolute max on-time (any source)

let SENSOR_PIN = 12;      // BCM 12, pin 32 — flow sensor input
let LOOPBACK_OUT_PIN = 24; // BCM 24, pin 18 — loopback output (permanently jumpered)
let LOOPBACK_IN_PIN = 23;  // BCM 23, pin 16 — loopback input (permanently jumpered)
let PUMP_PIN = 26;        // BCM 26, pin 37 — pump relay output
let HC12_SET_PIN = 13;    // BCM 13, pin 33 — HC12 SET pin
let HOT_LED_PIN = 22;     // BCM 22, pin 15 — HOT temperature LED
let FLOW_LED_PIN = 27;    // BCM 27, pin 13 — flow status LED
let PUMP_LED_PIN = 17;    // BCM 17, pin 11 — pump status LED
const HOT_LED_THRESHOLD = 40; // degrees C
let HC12_SERIAL_CHANNEL = 1;   // HC12 channel

let PUMP_WATTS = 0;           // pump power in watts (0 = not configured)
let HEATER_WATTS = 0;         // water heater power in watts (0 = not configured)
let HEATER_TEMP_SETTING = 0;  // heater thermostat setting in °C (0 = not configured)
const HEATER_TEMP_DEADBAND = 3; // °C — assume heating elements off when within this of setting

type CurrencySymbol = "$" | "¥" | "€";
let ENERGY_COST_RATE = 0;                       // cost per kWh (0 = not configured)
let ENERGY_COST_CURRENCY: CurrencySymbol = "$"; // currency symbol
let WATER_COST_RATE = 0;                        // cost per unit of water (0 = not configured); unit matches FLOW_UNITS (L or gal)

let HOMEKIT_PIN = "000-00-000";
let HOMEKIT_PORT = 47128;
let HOMEKIT_USERNAME = "00:00:00:00:00:00";

const DOOR_STILL_OPEN_SENTINEL = 99; // protocol value meaning "door left open"
const VALID_OYU_VERBS = new Set(["OPEN", "CLOSE", "BAT", "CPU", "SER", "VER"]);
let DOOR_MONITOR_ENABLED = false;
let DOOR_NAMES: Record<string, string> = {};  // sensor ID "0"-"99" → display name

type TempUnits = "C" | "F";
type FlowUnits = "L" | "G";
let TEMP_UNITS: TempUnits = "C";
let FLOW_UNITS: FlowUnits = "L";

let LOCALE_ID = "en";

const IS_LINUX = process.platform !== "darwin" && process.platform !== "win32";

let LOG_FILE = "flow.log";
let HISTORY_FILE = "flow_history.json";
let LOG_MAX_ROTATIONS = 30;
let LOG_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
let TEMP_LOG_THRESHOLD = 0.5; // °C delta to trigger a log entry

// ---- Configuration ----

interface FlowConfig {
    port?: number;
    tempPollInterval?: number;
    flowPollInterval?: number;
    flowStartDelay?: number;
    flowStopDelay?: number;
    pumpMaxRunTime?: number;
    sensorPin?: number;
    hc12SetPin?: number;
    hc12SerialChannel?: number;
    pumpPin?: number;
    logFile?: string;
    historyFile?: string;
    logMaxRotations?: number;
    logMaxSize?: number;
    tempLogThreshold?: number;
    hotLedPin?: number;
    flowLedPin?: number;
    pumpLedPin?: number;
    homekitPin?: string;
    homekitPort?: number;
    homekitUsername?: string;
    tempUnits?: TempUnits;
    flowUnits?: FlowUnits;
    locale?: string;
    pumpWatts?: number;
    heaterWatts?: number;
    heaterTempSetting?: number;
    energyCostRate?: number;
    energyCostCurrency?: CurrencySymbol;
    waterCostRate?: number;
    doorMonitorEnabled?: boolean;
    doorNames?: Record<string, string>;   // door ID "0"-"9" → display name
}

function loadConfig(): FlowConfig | undefined {
    if (!existsSync(CONFIG_FILE)) {
        return undefined;
    }
    try {
        const raw = readFileSync(CONFIG_FILE, "utf-8");
        console.log(`read config ${CONFIG_FILE}: ${raw}`);
        return JSON.parse(raw) as FlowConfig;
    } catch (e) {
        console.error(`warning: failed to parse ${CONFIG_FILE}: ${(e as Error).message}, using defaults`);
        return undefined;
    }
}

function applyConfig(cfg: FlowConfig): void {
    if (cfg.port !== undefined) { DEFAULT_PORT = cfg.port; }
    if (cfg.tempPollInterval !== undefined) { TEMP_POLL_INTERVAL = cfg.tempPollInterval * SECOND; }
    if (cfg.flowPollInterval !== undefined) { FLOW_POLL_INTERVAL = cfg.flowPollInterval * SECOND; }
    if (cfg.flowStartDelay !== undefined) { FLOW_START_DELAY = cfg.flowStartDelay * SECOND; }
    if (cfg.flowStopDelay !== undefined) { FLOW_STOP_DELAY = cfg.flowStopDelay * SECOND; }
    if (cfg.pumpMaxRunTime !== undefined) { PUMP_MAX_RUN_TIME = cfg.pumpMaxRunTime * MINUTE; }
    if (cfg.sensorPin !== undefined) { SENSOR_PIN = cfg.sensorPin; }
    if (cfg.hc12SetPin !== undefined) { HC12_SET_PIN = cfg.hc12SetPin; }
    if (cfg.hc12SerialChannel !== undefined) { HC12_SERIAL_CHANNEL = cfg.hc12SerialChannel; }
    if (cfg.pumpPin !== undefined) { PUMP_PIN = cfg.pumpPin; }
    if (cfg.logFile !== undefined) { LOG_FILE = cfg.logFile; }
    if (cfg.historyFile !== undefined) { HISTORY_FILE = cfg.historyFile; }
    if (cfg.logMaxRotations !== undefined) { LOG_MAX_ROTATIONS = cfg.logMaxRotations; }
    if (cfg.logMaxSize !== undefined) { LOG_MAX_SIZE = cfg.logMaxSize; }
    if (cfg.tempLogThreshold !== undefined) { TEMP_LOG_THRESHOLD = cfg.tempLogThreshold; }
    if (cfg.hotLedPin !== undefined) { HOT_LED_PIN = cfg.hotLedPin; }
    if (cfg.flowLedPin !== undefined) { FLOW_LED_PIN = cfg.flowLedPin; }
    if (cfg.pumpLedPin !== undefined) { PUMP_LED_PIN = cfg.pumpLedPin; }
    if (cfg.homekitPin !== undefined) { HOMEKIT_PIN = cfg.homekitPin; }
    if (cfg.homekitPort !== undefined) { HOMEKIT_PORT = cfg.homekitPort; }
    if (cfg.homekitUsername !== undefined) { HOMEKIT_USERNAME = cfg.homekitUsername; }
    // Load locale first — its unit defaults apply before explicit config overrides
    if (cfg.locale !== undefined) { LOCALE_ID = cfg.locale; }
    LOCALE = loadLocale(LOCALE_ID);
    if (LOCALE.tempUnits !== undefined) { TEMP_UNITS = LOCALE.tempUnits; }
    if (LOCALE.flowUnits !== undefined) { FLOW_UNITS = LOCALE.flowUnits; }
    // Explicit config overrides locale defaults
    if (cfg.tempUnits !== undefined) { TEMP_UNITS = cfg.tempUnits; }
    if (cfg.flowUnits !== undefined) { FLOW_UNITS = cfg.flowUnits; }
    if (cfg.pumpWatts !== undefined) { PUMP_WATTS = cfg.pumpWatts; }
    if (cfg.heaterWatts !== undefined) { HEATER_WATTS = cfg.heaterWatts; }
    if (cfg.heaterTempSetting !== undefined) { HEATER_TEMP_SETTING = cfg.heaterTempSetting; }
    if (cfg.energyCostRate !== undefined) { ENERGY_COST_RATE = cfg.energyCostRate; }
    if (cfg.energyCostCurrency !== undefined) { ENERGY_COST_CURRENCY = cfg.energyCostCurrency; }
    if (cfg.waterCostRate !== undefined) { WATER_COST_RATE = cfg.waterCostRate; }
    if (cfg.doorMonitorEnabled !== undefined) { DOOR_MONITOR_ENABLED = cfg.doorMonitorEnabled; }
    if (cfg.doorNames !== undefined) { DOOR_NAMES = cfg.doorNames; }
}

// ---- Locale / i18n ----

interface LocaleStrings {
    locale: string;
    langCode: string;
    tempUnits?: TempUnits;
    flowUnits?: FlowUnits;
    [key: string]: string | undefined;
}

const DEFAULT_LOCALE: LocaleStrings = {
    locale: "en", langCode: "en",
    pageTitle: "Hot Water System", heading: "Hot Water System v{version}",
    systemDiagram: "System Diagram", flowMeter: "FLOW METER", pump: "PUMP", waterHeater: "WATER HEATER", noFlow: "No flow",
    temperature: "Temperature", noTempSensors: "No temperature sensors detected",
    ago: "{duration} ago", flowRate: "Flow Rate", changedAgo: "Changed {duration} ago",
    pumpHeading: "Pump", pumpOn: "ON", pumpOff: "OFF", sinceAgo: "Since {duration} ago",
    turnOn: "Turn ON", turnOff: "Turn OFF",
    statusLeds: "Status LEDs", ledError: "ERROR", ledStartup: "STARTUP",
    ledHot: "HOT", ledFlow: "Flow", ledPump: "Pump",
    ledErrorFlash: "error flash", ledStartupMode: "startup",
    ledOn: "on", ledOff: "off", ledSlowBlink: "slow blink", ledFastBlink: "fast blink",
    statistics: "Statistics", statsToday: "Today", stats7Days: "7 Days", stats30Days: "30 Days",
    totalFlow: "Total flow", pumpOnTime: "Pump on-time", pumpEnergy: "Pump energy", heaterEnergy: "Heater energy",
    avgPrefix: "Avg {name}", hotPumping: "Hot (pumping)",
    homekitPairing: "HomeKit Pairing", pinLabel: "Pin: {pin}",
    started: "Started", uptime: "uptime",
    thermCold: "COLD", thermHot: "HOT",
    settings: "Settings", settingsTitle: "Settings",
    settingPumpWatts: "Pump power", settingHeaterWatts: "Heater power", settingWattsUnit: "watts",
    settingHeaterTempSetting: "Heater thermostat",
    settingEnergyCostRate: "Energy cost rate", settingEnergyCostCurrency: "Currency", settingWaterCostRate: "Water cost rate",
    currencyDollar: "Dollar", currencyEuro: "Euro", currencyYen: "Yen", calendarGo: "Go",
    wifiConnected: "connected", wifiConnectFailed: "Connection failed",
    settingPumpMaxRunTime: "Pump max run time", settingPumpMaxRunTimeUnit: "minutes",
    settingFlowStartDelay: "Flow start delay", settingFlowStartDelayUnit: "seconds",
    settingFlowStopDelay: "Flow stop delay", settingFlowStopDelayUnit: "seconds",
    settingDoorMonitor: "Door monitor", settingDoorEnabled: "Enabled", settingDoorDisabled: "Disabled",
    settingDoorHomekitWarning: "Changing this setting requires re-pairing with HomeKit to update accessories.",
    settingDoorName: "Door {id} name", settingDoorNamePlaceholder: "Not configured",
    settingLocale: "Language", settingTempUnits: "Temperature units", settingFlowUnits: "Flow units",
    settingTempC: "Celsius (\u00b0C)", settingTempF: "Fahrenheit (\u00b0F)",
    settingFlowL: "Liters (L/min)", settingFlowG: "Gallons (gal/min)",
    settingSave: "Save", settingsSaved: "Settings saved.",
    settingsBackToDashboard: "Back to dashboard",
    calendar: "Usage", calendarTitle: "Daily Usage",
    calendarDate: "Date", calendarToday: "Today",
    calendarEnergy: "Energy", calendarPumpEnergy: "Pump energy", calendarHeaterEnergy: "Heater energy",
    calendarWaterCost: "Water cost",
    calendarEnergyCost: "Energy cost", calendarPumpEnergyCost: "Pump energy cost", calendarHeaterEnergyCost: "Heater energy cost",
    calendarPumpRunTime: "Pump run time",
    calendarTotalFlow: "Total flow",
    calendarTemperatures: "Temperatures",
    calendarTempAvg: "avg", calendarTempMin: "min", calendarTempMax: "max",
    calendarHotAboveThreshold: "Hot above {threshold}",
    calendarNoData: "No data recorded for this date.",
    calendarBackToDashboard: "Back to dashboard",
    calendarWeekTitle: "Weekly Usage",
    calendarWeek: "Week",
    calendarDay: "Day",
    daySun: "Sun", dayMon: "Mon", dayTue: "Tue", dayWed: "Wed",
    dayThu: "Thu", dayFri: "Fri", daySat: "Sat",
    monthNames: "January,February,March,April,May,June,July,August,September,October,November,December",
    calendarMonth: "Month", calendarMonthTitle: "Monthly Usage",
    calendarMonthTotal: "Monthly Total", calendarWeekTotal: "Weekly Total",
    network: "Network", networkConnection: "Connection", networkIP: "IP Address",
    networkMAC: "MAC", networkSubnet: "Subnet", networkGateway: "Gateway", networkDashboardVia: "Dashboard via",
    networkSSID: "SSID", networkUnavailable: "Network info unavailable",
    errorNoTemperature: "Missing temperature sensors",
    errorNoLoopback: "Loopback connector not detected",
    errorNoConnection: "No network connection",
    errorNoGateway: "No gateway detected",
    errorOther: "System error",
    wifi: "Wi-Fi", wifiTitle: "Wi-Fi Networks",
    wifiKnownNetworks: "Known Networks",
    wifiOtherNetworks: "Other Networks",
    wifiSignal: "Signal", wifiSecurity: "Security",
    wifiPassword: "Password", wifiShowPassword: "Show", wifiHidePassword: "Hide",
    wifiConnect: "Connect", wifiOpen: "Open", wifiSecured: "WPA2",
    wifiConnecting: "Connecting...", wifiCancel: "Cancel",
    wifiSuccess: "Connected successfully.",
    wifiFailReconnect: "Connection failed. Reconnected to previous network.",
    wifiFailNoFallback: "Connection failed.",
    wifiDisconnectWarning: "Warning: Changing or turning off Wi-Fi may disconnect this dashboard. If the new connection fails, the system will attempt to reconnect to the previous network. Turn off Wi-Fi only when an Ethernet cable is connected.",
    wifiBackToDashboard: "Back to dashboard",
    wifiNoNetworks: "No Wi-Fi networks found.",
    wifiNotAvailable: "Wi-Fi configuration is only available on the Raspberry Pi.",
    wifiApMode: "Setup Mode: Connect to a Wi-Fi network to complete setup. This device will disconnect from the setup network once connected.",
    wifiNotConnected: "Not connected to any Wi-Fi network",
    wifiDisconnect: "Disconnect",
    wifiDisconnecting: "Disconnecting...",
    wifiDisconnected: "Disconnected from Wi-Fi.",
    wifiReconnect: "Reconnect",
    wifiSavedPassword: "Saved password available — enter a new one to replace it, or reconnect with the saved password.",
    wifiTurnOff: "Turn off Wi-Fi",
    wifiTurnOn: "Turn on Wi-Fi",
    wifiOff: "Wi-Fi is turned off. Connected via Ethernet.",
    doors: "Doors", doorNoEvents: "No door events",
    doorOpenDuration: "open {duration}", doorStillOpen: "still open",
    log: "Log", logTitle: "System Log", logBackToDashboard: "Back to dashboard",
    logEmpty: "No log entries.", logFilter: "Level:", logArea: "Area:", logFilterAll: "All",
    logFilterInfo: "Info and above", logFilterImportant: "Important and above",
    restart: "Restart",
    restartConfirm: "Restart the system? The dashboard will be unavailable for a few seconds.",
    restartMessage: "Restarting...",
    sensorHot: "Hot", sensorCold: "Cold", sensorAmbient: "Ambient",
    sensorSetup: "Sensor Setup", sensorSetupTitle: "Assign Temperature Sensors",
    sensorSetupDesc: "Assign a role to each detected temperature sensor. Only Hot is required.",
    sensorRoleNone: "(none)",
    sensorRoleRequired: "A sensor must be assigned the Hot role.",
    sensorRoleDuplicate: "Each role can only be assigned to one sensor.",
    sensorMissing: "Configured sensor not connected: {id} ({role})",
    sensorSaved: "Sensor configuration saved.",
    sensorBackToSettings: "Back to settings",
};

let LOCALE: LocaleStrings = { ...DEFAULT_LOCALE };

function loadLocale(localeId: string): LocaleStrings {
    const candidates = [
        join("locales", `${localeId}.json`),                                // cwd
        join(dirname(process.argv[1] || "."), "locales", `${localeId}.json`), // beside script
        join(dirname(process.argv[1] || "."), "..", "locales", `${localeId}.json`), // parent of script (e.g. out/)
    ];
    for (const p of candidates) {
        if (existsSync(p)) {
            return { ...DEFAULT_LOCALE, ...JSON.parse(readFileSync(p, "utf-8")) };
        }
    }
    if (localeId !== "en") {
        console.error(`warning: locale file not found for "${localeId}", using defaults`);
    }
    return { ...DEFAULT_LOCALE };
}

/** Look up a locale string, substituting {placeholder} tokens. */
function L(key: string, params?: Record<string, string>): string {
    let s = LOCALE[key] ?? DEFAULT_LOCALE[key] ?? key;
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            s = s.replace(`{${k}}`, v);
        }
    }
    return s;
}

// ---- Sensor Config ----
// Maps 1-wire device IDs to roles ("Hot", "Cold", "Ambient").
// Stored in sensor_config.json, editable via /sensor-setup page.

interface SensorNameConfig {
    [deviceId: string]: string;
}

interface SensorConfig {
    sensors: SensorNameConfig;
}

const SENSOR_CONFIG_FILE = "sensor_config.json";
const VALID_SENSOR_ROLES = ["Hot", "Cold", "Ambient"] as const;
type SensorRole = typeof VALID_SENSOR_ROLES[number];

let sensorConfig: SensorConfig | undefined;

function loadSensorConfig(): SensorConfig | undefined {
    if (!existsSync(SENSOR_CONFIG_FILE)) { return undefined; }
    try {
        const raw = readFileSync(SENSOR_CONFIG_FILE, "utf-8");
        const parsed = JSON.parse(raw) as SensorConfig;
        if (!parsed.sensors || typeof parsed.sensors !== "object") { return undefined; }
        return parsed;
    } catch {
        return undefined;
    }
}

function saveSensorConfig(config: SensorConfig): void {
    writeFileSync(SENSOR_CONFIG_FILE, JSON.stringify(config, null, 4) + "\n");
    sensorConfig = config;
}

/** Localized display name for a sensor role. */
function sensorDisplayName(role: string): string {
    const key = `sensor${role}`;
    const localized = L(key);
    return localized !== key ? localized : role;
}

// ---- Interfaces ----

interface DoorState {
    doorId: number;
    name: string;
    lastOpenTime: number;      // ms timestamp when door last opened (0 = never)
    lastOpenSeconds: number;   // how long it was open
    stillOpen: boolean;        // true if door is currently open (no CLOSE received)
}

interface StatusResponse {
    time: number;
    temperature: { name: string; celsius: number; timeSinceLastChange: number }[];
    flow: { lpm: number; timeSinceLastChange: number };
    pump: { state: boolean; source: "auto" | "user" | undefined; timeSinceLastChange: number };
    heaterActive: boolean;
    doors: DoorState[];
    stats: StatsSnapshot;
    start: number;
    status: string;
    error?: string;
}

interface TemperatureSensorReading {
    sensor: number;
    name: string;
    celsius: number;
    timeSinceLastChange: number;
}

interface TemperatureResponse {
    time: number;
    sensors: TemperatureSensorReading[];
}

interface FlowResponse {
    time: number;
    lpm: number;
    timeSinceLastChange: number;
}

type PumpSource = "auto" | "user" | undefined;

// Sparse timeline: [minute, hotCelsius|null, flowLpm, heaterActive(0|1)?]
type SparsePoint = [number, number | null, number] | [number, number | null, number, number];

interface SparseTimeline {
    points: SparsePoint[];
    pumpIntervals: [number, number][]; // [start, end] pairs in minutes
}

interface DaySummary {
    date: string;
    flowLiters: number;
    pumpOnMinutes: number;
    pumpOnSeconds?: number;          // precise value for restoration across restarts
    heaterOnSeconds?: number;        // precise value for restoration across restarts
    avgTemps: { name: string; avgCelsius: number }[];
    tempRanges?: { name: string; minCelsius: number; maxCelsius: number }[];
    hotAboveThresholdMinutes?: number;
    hotAboveThresholdSeconds?: number; // precise value for restoration across restarts
    hotAvgWhilePumping: number | undefined;
    pumpEnergyKwh?: number;
    heaterEnergyKwh?: number;
    timeline?: SparseTimeline;       // per-minute data for day chart
}

interface RollingStats {
    days: number;
    flowLiters: number;
    pumpOnMinutes: number;
    avgTemps: { name: string; avgCelsius: number }[];
    hotAvgWhilePumping: number | undefined;
    pumpEnergyKwh: number;
    heaterEnergyKwh: number;
}

interface StatsSnapshot {
    today: DaySummary;
    week: RollingStats;
    month: RollingStats;
}

interface PumpResponse {
    time: number;
    state: boolean;
    source: PumpSource;
    timeSinceLastChange: number;
}

// ---- Utilities ----

function cToF(c: number): number {
    return c * 9 / 5 + 32;
}

function fToC(f: number): number {
    return (f - 32) * 5 / 9;
}

function lpmToGpm(lpm: number): number {
    return lpm * 0.264172;
}

function litersToGallons(liters: number): number {
    return liters * 0.264172;
}

/** Format a temperature for display using the configured units. */
function formatTemp(celsius: number | undefined): string {
    if (celsius === undefined || celsius === null) { return "--"; }
    if (TEMP_UNITS === "F") {
        return `${cToF(celsius).toFixed(1)}\u00b0F`;
    }
    return `${celsius.toFixed(1)}\u00b0C`;
}

/** Format a temperature without the unit letter (for compact display). */
function formatTempShort(celsius: number | undefined): string {
    if (celsius === undefined || celsius === null) { return "--"; }
    if (TEMP_UNITS === "F") {
        return `${cToF(celsius).toFixed(1)}\u00b0`;
    }
    return `${celsius.toFixed(1)}\u00b0`;
}

/** Format a flow rate for display using the configured units. */
function formatFlow(lpm: number): string {
    if (lpm === 0) { return L("noFlow"); }
    if (FLOW_UNITS === "G") {
        return `${lpmToGpm(lpm).toFixed(2)} gal/min`;
    }
    return `${lpm.toFixed(2)} L/min`;
}

/** Format a volume total for display using the configured units. */
function formatVolume(liters: number): string {
    if (FLOW_UNITS === "G") {
        return `${litersToGallons(liters).toFixed(1)} gal`;
    }
    return `${liters.toFixed(1)} L`;
}

function formatEnergy(kwh: number | undefined): string {
    if (kwh === undefined) { return "--"; }
    if (kwh === 0) { return "0 Wh"; }
    if (kwh < 1) { return `${Math.round(kwh * 1000)} Wh`; }
    return `${kwh.toFixed(2)} kWh`;
}

function formatCost(kwh: number): string {
    if (ENERGY_COST_RATE <= 0) { return ""; }
    const cost = kwh * ENERGY_COST_RATE;
    if (ENERGY_COST_CURRENCY === "¥") {
        return `${ENERGY_COST_CURRENCY}${Math.round(cost)}`;
    }
    return `${ENERGY_COST_CURRENCY}${cost.toFixed(2)}`;
}

/** Format water cost from liters, converting to configured flow units. Rate is per 1000 units (L or gal). */
function formatWaterCost(liters: number): string {
    if (WATER_COST_RATE <= 0) { return ""; }
    const units = FLOW_UNITS === "G" ? litersToGallons(liters) : liters;
    const cost = units * WATER_COST_RATE / 1000;
    if (ENERGY_COST_CURRENCY === "¥") {
        return `${ENERGY_COST_CURRENCY}${Math.round(cost)}`;
    }
    return `${ENERGY_COST_CURRENCY}${cost.toFixed(2)}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function periodToHertz(periodMSecs: number): number {
    if (periodMSecs === 0) {
        return 0;
    }
    return 1000 / periodMSecs;
}

const MAX_FLOW_LPM = 50; // physical limit — clamp to reject timer jitter artifacts

function pwToFlow(periodMSecs: number): number {
    // Flow formula: F = (8.1Q - 5) ±10%
    // Solving for Q: Q = (F + 5) / 8.1
    const f = periodToHertz(periodMSecs);
    if (f === 0) {
        return 0;
    }
    return Math.min((f + 5) / 8.1, MAX_FLOW_LPM);
}

function timeString(t: number): string {
    const d = new Date(t);
    const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
    return `${d.toLocaleTimeString(undefined, options)}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}

// ---- Activity Logger ----

function logTimestamp(t: number = Date.now()): string {
    const d = new Date(t);
    const pad = (n: number, w = 2): string => n.toString().padStart(w, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function dateString(t: number = Date.now()): string {
    const d = new Date(t);
    const pad = (n: number): string => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

class ActivityLogger {
    constructor(private readonly logDir: string) {
        const path = join(logDir, LOG_FILE);
        if (!existsSync(path)) {
            writeFileSync(path, "");
        }
    }

    public get logPath(): string {
        return join(this.logDir, LOG_FILE);
    }

    private writeLine(type: string, detail: string, t: number = Date.now()): void {
        const line = `${logTimestamp(t)}  ${type.padEnd(8)}${detail}\n`;
        try {
            if (existsSync(this.logPath) && statSync(this.logPath).size >= LOG_MAX_SIZE) {
                this.rotateLogs();
            }
            appendFileSync(this.logPath, line);
        } catch (e) {
            // swallow — logging must not crash the server
        }
    }

    public logPumpChange(on: boolean, source: PumpSource): void {
        const sourceLabel = source ? ` (${source})` : "";
        this.writeLine("PUMP", `${on ? "ON" : "OFF"}${sourceLabel}`);
    }

    public logFlowChange(started: boolean, lpm: number): void {
        this.writeLine("FLOW", started ? `START ${formatFlow(lpm)}` : "STOP");
    }

    public logTemperatureChange(name: string, oldCelsius: number, newCelsius: number): void {
        this.writeLine("TEMP", `${name} ${formatTemp(oldCelsius)} -> ${formatTemp(newCelsius)}`);
    }

    public writeDailySummary(summary: DaySummary): void {
        const temps = summary.avgTemps.map((t) => `${t.name}=${formatTemp(t.avgCelsius)}`).join(" ");
        const energy = [
            summary.pumpEnergyKwh !== undefined ? `pumpEnergy=${formatEnergy(summary.pumpEnergyKwh)}` : "",
            summary.heaterEnergyKwh !== undefined ? `heaterEnergy=${formatEnergy(summary.heaterEnergyKwh)}` : "",
        ].filter(Boolean).join(" ");
        this.writeLine("DAILY", `flow=${formatVolume(summary.flowLiters)} pump=${summary.pumpOnMinutes.toFixed(0)}min ${temps}${energy ? " " + energy : ""}`);
    }

    public rotateLogs(): void {
        const logPath = this.logPath;
        if (!existsSync(logPath)) {
            return;
        }
        const today = dateString();
        const rotated = join(this.logDir, `flow_${today}.log`);
        try {
            renameSync(logPath, rotated);
        } catch (e) {
            // swallow
        }
        // Prune old rotated logs
        try {
            const files = readdirSync(this.logDir)
                .filter((f) => f.startsWith("flow_") && f.endsWith(".log"))
                .sort()
                .reverse();
            for (let i = LOG_MAX_ROTATIONS; i < files.length; i++) {
                unlinkSync(join(this.logDir, files[i]));
            }
        } catch (e) {
            // swallow
        }
    }
}

/** Read the activity log backwards to find the most recent PUMP, FLOW, and TEMP state changes. */
function readLastStateChanges(logPath: string): { pump?: number; flow?: number; temp?: number } {
    const result: { pump?: number; flow?: number; temp?: number } = {};
    if (!existsSync(logPath)) {
        return result;
    }
    try {
        const content = readFileSync(logPath, "utf-8");
        const lines = content.trimEnd().split("\n");
        // Scan backwards — stop once all three are found
        for (let i = lines.length - 1; i >= 0 && (result.pump === undefined || result.flow === undefined || result.temp === undefined); i--) {
            const line = lines[i];
            // Format: "2026-03-10 00:01:37.266  PUMP    OFF"
            const tsStr = line.substring(0, 23);
            const rest = line.substring(23).trim();
            const type = rest.split(/\s+/)[0];
            const ts = new Date(tsStr).getTime();
            if (isNaN(ts)) { continue; }
            if (type === "PUMP" && result.pump === undefined) {
                result.pump = ts;
            } else if (type === "FLOW" && result.flow === undefined) {
                result.flow = ts;
            } else if (type === "TEMP" && result.temp === undefined) {
                result.temp = ts;
            }
        }
    } catch {
        // swallow — missing or unreadable log is fine
    }
    return result;
}

// ---- History Store ----

class HistoryStore {
    private days: DaySummary[] = [];

    constructor(private readonly filePath: string) {
        if (!existsSync(this.filePath)) {
            writeFileSync(this.filePath, "[]");
        }
        this.load();
    }

    public load(): void {
        try {
            if (existsSync(this.filePath)) {
                const raw = readFileSync(this.filePath, "utf-8");
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    this.days = parsed;
                }
            }
        } catch (e) {
            console.error("Failed to load history", e);
            logger.logError(LogSeverity.Severe, LogArea.Server, e as Error, "Failed to load history");
            this.days = [];
        }
    }

    public appendDay(summary: DaySummary): void {
        this.days.push(summary);
        // Keep max 31 days
        if (this.days.length > 31) {
            this.days = this.days.slice(this.days.length - 31);
        }
        this.save();
    }

    /** Insert or replace a day summary (used on shutdown to persist partial-day data). */
    public upsertDay(summary: DaySummary): void {
        const idx = this.days.findIndex((d) => d.date === summary.date);
        if (idx >= 0) {
            this.days[idx] = summary;
        } else {
            this.days.push(summary);
            if (this.days.length > 31) {
                this.days = this.days.slice(this.days.length - 31);
            }
        }
        this.save();
    }

    private savePromise: Promise<void> = Promise.resolve();

    private save(): void {
        this.savePromise = this.savePromise.then(() => this.saveAsync()).catch((e) => {
            console.error("Failed to save history", e);
            logger.logError(LogSeverity.Severe, LogArea.Server, e as Error, "Failed to save history");
        });
    }

    /** Wait for any pending save to complete. */
    public flush(): Promise<void> {
        return this.savePromise;
    }

    private async saveAsync(): Promise<void> {
        const tmp = this.filePath + ".tmp";
        const json = JSON.stringify(this.days, null, 2);
        await writeFile(tmp, json);
        await rename(tmp, this.filePath);
        // Trim oldest entries if file exceeds size limit
        while (this.days.length > 1 && (await stat(this.filePath)).size > LOG_MAX_SIZE) {
            this.days.shift();
            const trimmed = JSON.stringify(this.days, null, 2);
            await writeFile(tmp, trimmed);
            await rename(tmp, this.filePath);
        }
    }

    public getRollingStats(numDays: number): RollingStats {
        const slice = this.days.slice(-numDays);
        const stats: RollingStats = {
            days: slice.length,
            flowLiters: 0,
            pumpOnMinutes: 0,
            avgTemps: [],
            hotAvgWhilePumping: undefined,
            pumpEnergyKwh: 0,
            heaterEnergyKwh: 0,
        };
        if (slice.length === 0) {
            return stats;
        }
        const tempSums: Record<string, { sum: number; count: number }> = {};
        let hotPumpSum = 0;
        let hotPumpCount = 0;
        for (const day of slice) {
            stats.flowLiters += day.flowLiters;
            stats.pumpOnMinutes += day.pumpOnMinutes;
            stats.pumpEnergyKwh += day.pumpEnergyKwh ?? 0;
            stats.heaterEnergyKwh += day.heaterEnergyKwh ?? 0;
            for (const t of day.avgTemps) {
                if (!tempSums[t.name]) {
                    tempSums[t.name] = { sum: 0, count: 0 };
                }
                tempSums[t.name].sum += t.avgCelsius;
                tempSums[t.name].count++;
            }
            if (day.hotAvgWhilePumping !== undefined) {
                hotPumpSum += day.hotAvgWhilePumping;
                hotPumpCount++;
            }
        }
        stats.avgTemps = Object.entries(tempSums).map(([name, { sum, count }]) => ({
            name,
            avgCelsius: Math.round((sum / count) * 10) / 10,
        }));
        if (hotPumpCount > 0) {
            stats.hotAvgWhilePumping = Math.round((hotPumpSum / hotPumpCount) * 10) / 10;
        }
        return stats;
    }

    public getAllDays(): DaySummary[] {
        return [...this.days];
    }

    public getDay(date: string): DaySummary | undefined {
        return this.days.find((d) => d.date === date);
    }
}

// ---- Day Timeline ----

interface TimelinePoint {
    minute: number;           // 0–1439 (minute of day)
    hotCelsius?: number;      // HOT sensor reading
    flowLpm: number;          // instantaneous flow
    heaterActive?: boolean;   // heater was active this minute
}

interface PumpInterval {
    startMinute: number;
    endMinute?: number;       // undefined = still running
}

class DayTimeline {
    public readonly date: string;
    public readonly points: (TimelinePoint | undefined)[] = new Array(1440);
    public readonly pumpIntervals: PumpInterval[] = [];
    private lastPumpState = false;

    constructor(date: string) {
        this.date = date;
    }

    /** Record a data point (called once per minute from StatsAccumulator). */
    public record(minute: number, hotCelsius: number | undefined, flowLpm: number, heaterActive?: boolean): void {
        this.points[minute] = { minute, hotCelsius, flowLpm, heaterActive };
    }

    /** Notify pump state change so we track precise intervals. */
    public pumpChanged(on: boolean, minute: number): void {
        if (on && !this.lastPumpState) {
            this.pumpIntervals.push({ startMinute: minute });
        } else if (!on && this.lastPumpState) {
            const current = this.pumpIntervals[this.pumpIntervals.length - 1];
            if (current && current.endMinute === undefined) {
                current.endMinute = minute;
            }
        }
        this.lastPumpState = on;
    }

    /** Total minutes the pump was on. */
    public totalPumpMinutes(nowMinute?: number): number {
        let total = 0;
        for (const iv of this.pumpIntervals) {
            const end = iv.endMinute ?? nowMinute ?? 1440;
            total += end - iv.startMinute;
        }
        return total;
    }

    /** Total minutes the HOT sensor was at or above the threshold. */
    public hotAboveThresholdMinutes(): number {
        let count = 0;
        for (const p of this.points) {
            if (p && p.hotCelsius !== undefined && p.hotCelsius >= HOT_LED_THRESHOLD) {
                count++;
            }
        }
        return count;
    }

    /** Total flow in liters (each point represents 1 minute of flow at lpm). */
    public totalFlowLiters(): number {
        let total = 0;
        for (const p of this.points) {
            if (p) { total += p.flowLpm; } // lpm × 1 min = liters
        }
        return total;
    }

    /** Close any open pump interval at the given minute. */
    public closePumpInterval(minute: number): void {
        const current = this.pumpIntervals[this.pumpIntervals.length - 1];
        if (current && current.endMinute === undefined) {
            current.endMinute = minute;
        }
    }

    /** JSON-serializable snapshot for the chart. */
    public toChartData(): { points: TimelinePoint[]; pumpIntervals: PumpInterval[] } {
        const pts: TimelinePoint[] = [];
        for (const p of this.points) {
            if (p) { pts.push(p); }
        }
        return { points: pts, pumpIntervals: this.pumpIntervals };
    }

    /** Export to sparse format: only store points where values changed meaningfully.
     *  Temperature: recorded when it changes by ≥ 0.3°C or every 15 minutes.
     *  Flow/heater: recorded whenever they change.
     */
    public toSparse(): SparseTimeline {
        const sparse: SparsePoint[] = [];
        let lastTemp: number | undefined;
        let lastTempMinute = -100;
        let lastFlow = -1;
        let lastHeater = -1;
        let lastDefinedPoint: TimelinePoint | undefined;

        for (const p of this.points) {
            if (!p) continue;
            let store = false;
            const tempChanged = p.hotCelsius !== undefined && (
                lastTemp === undefined ||
                Math.abs(p.hotCelsius - lastTemp) >= 0.3 ||
                p.minute - lastTempMinute >= 15
            );
            if (tempChanged) store = true;
            if (p.flowLpm !== lastFlow) store = true;
            const h = p.heaterActive ? 1 : 0;
            if (h !== lastHeater) store = true;

            if (store) {
                const t = p.hotCelsius !== undefined ? Math.round(p.hotCelsius * 10) / 10 : null;
                const f = Math.round(p.flowLpm * 100) / 100;
                if (h !== 0) {
                    sparse.push([p.minute, t, f, h]);
                } else {
                    sparse.push([p.minute, t, f]);
                }
                if (p.hotCelsius !== undefined) {
                    lastTemp = p.hotCelsius;
                    lastTempMinute = p.minute;
                }
                lastFlow = p.flowLpm;
                lastHeater = h;
                lastDefinedPoint = undefined; // was stored, no need to append later
            } else {
                lastDefinedPoint = p; // track last unstored point
            }
        }

        // Always store the last point so interpolation covers the full range
        if (lastDefinedPoint) {
            const p = lastDefinedPoint;
            const t = p.hotCelsius !== undefined ? Math.round(p.hotCelsius * 10) / 10 : null;
            const f = Math.round(p.flowLpm * 100) / 100;
            const h = p.heaterActive ? 1 : 0;
            if (h !== 0) {
                sparse.push([p.minute, t, f, h]);
            } else {
                sparse.push([p.minute, t, f]);
            }
        }

        const intervals: [number, number][] = this.pumpIntervals.map(
            (iv) => [iv.startMinute, iv.endMinute ?? 1440]
        );

        return { points: sparse, pumpIntervals: intervals };
    }

    /** Reconstruct a DayTimeline from sparse data, interpolating temperature between stored points. */
    public static fromSparse(date: string, sparse: SparseTimeline): DayTimeline {
        const tl = new DayTimeline(date);

        // First pass: place stored points directly
        let lastTemp: number | undefined;
        let lastFlow = 0;
        let lastHeater = false;
        const storedMinutes: number[] = [];

        for (const sp of sparse.points) {
            const [minute, temp, flow, heater] = sp;
            if (temp !== null) lastTemp = temp;
            // Cap flow at a sane maximum — pre-debounce data can have spurious spikes
            lastFlow = Math.min(flow, 30);
            lastHeater = (heater ?? 0) === 1;
            tl.points[minute] = {
                minute,
                hotCelsius: lastTemp,
                flowLpm: lastFlow,
                heaterActive: lastHeater,
            };
            storedMinutes.push(minute);
        }

        // Second pass: interpolate temperature between stored points
        // Flow and heater are episodic — only use stored values, don't hold across gaps
        for (let i = 0; i < storedMinutes.length - 1; i++) {
            const m1 = storedMinutes[i];
            const m2 = storedMinutes[i + 1];
            const p1 = tl.points[m1]!;
            const p2 = tl.points[m2]!;
            const t1 = p1.hotCelsius;
            const t2 = p2.hotCelsius;

            // Fill gaps between stored points
            for (let m = m1 + 1; m < m2; m++) {
                const interpTemp = (t1 !== undefined && t2 !== undefined)
                    ? Math.round((t1 + (t2 - t1) * (m - m1) / (m2 - m1)) * 10) / 10
                    : (t1 ?? t2);
                tl.points[m] = {
                    minute: m,
                    hotCelsius: interpTemp,
                    flowLpm: 0,       // flow is episodic — 0 unless explicitly recorded
                    heaterActive: false,
                };
            }
        }

        // Restore pump intervals
        for (const [start, end] of sparse.pumpIntervals) {
            tl.pumpIntervals.push({ startMinute: start, endMinute: end });
        }

        return tl;
    }
}

// ---- Stats Accumulator ----

class StatsAccumulator {
    private currentDate: string;
    private totalFlowLiters = 0;
    private pumpOnSeconds = 0;
    private tempSums: Record<string, { sum: number; count: number }> = {};
    private tempRanges: Record<string, { min: number; max: number }> = {};
    private hotPumpSum = 0;
    private hotPumpCount = 0;
    private hotAboveThresholdSeconds = 0;
    private heaterOnSeconds = 0;
    public timeline: DayTimeline;
    private lastRecordedMinute = -1;

    constructor(
        private readonly activityLogger: ActivityLogger,
        private readonly history: HistoryStore,
        private readonly nowFn: () => number = Date.now
    ) {
        this.currentDate = dateString(this.nowFn());
        // Restore partial-day data from a previous run (if any)
        const existing = this.history.getDay(this.currentDate);
        // Restore timeline from history so chart data survives restarts
        this.timeline = existing?.timeline
            ? DayTimeline.fromSparse(this.currentDate, existing.timeline)
            : new DayTimeline(this.currentDate);
        if (existing) {
            this.totalFlowLiters = existing.flowLiters;
            // Use precise seconds if available, otherwise fall back to rounded minutes
            this.pumpOnSeconds = existing.pumpOnSeconds ?? Math.round(existing.pumpOnMinutes * MINUTE_SECONDS);
            this.heaterOnSeconds = existing.heaterOnSeconds ?? 0;
            this.hotAboveThresholdSeconds = existing.hotAboveThresholdSeconds
                ?? Math.round((existing.hotAboveThresholdMinutes ?? 0) * MINUTE_SECONDS);
            // Restore temperature averages so they blend with new readings
            for (const t of existing.avgTemps) {
                // Use a synthetic count of 1 so the running average merges naturally
                this.tempSums[t.name] = { sum: t.avgCelsius, count: 1 };
            }
            // Restore min/max temperature ranges
            if (existing.tempRanges) {
                for (const r of existing.tempRanges) {
                    this.tempRanges[r.name] = { min: r.minCelsius, max: r.maxCelsius };
                }
            }
            if (existing.hotAvgWhilePumping !== undefined) {
                this.hotPumpSum = existing.hotAvgWhilePumping;
                this.hotPumpCount = 1;
            }
            logger.log(LogSeverity.Info, LogArea.Server,
                `restored partial day ${this.currentDate}: flow=${existing.flowLiters}L pump=${this.pumpOnSeconds}s`);
        }
    }

    public tick(lpm: number, pumpOn: boolean, temps: { name: string; celsius: number | undefined }[], heaterActive: boolean): void {
        const now = this.nowFn();
        const today = dateString(now);

        // Midnight rollover
        if (today !== this.currentDate) {
            this.timeline.closePumpInterval(1440);
            const summary = this.toSummary();
            this.activityLogger.writeDailySummary(summary);
            this.history.appendDay(summary);
            this.activityLogger.rotateLogs();
            this.reset(today);
        }

        // Accumulate flow
        if (lpm > 0) {
            this.totalFlowLiters += lpm / MINUTE_SECONDS; // 1 tick = 1 second
        }

        // Accumulate pump time
        if (pumpOn) {
            this.pumpOnSeconds++;
        }

        // Accumulate heater heating time — only count when elements are likely firing
        if (heaterActive && HEATER_WATTS > 0) {
            if (HEATER_TEMP_SETTING > 0) {
                // Use Hot sensor to estimate whether heating elements are on:
                // elements fire when hot water temp is below the thermostat setting minus deadband
                const hot = findReadingByRole(temps, "Hot");
                if (hot?.celsius !== undefined && hot.celsius < HEATER_TEMP_SETTING - HEATER_TEMP_DEADBAND) {
                    this.heaterOnSeconds++;
                }
            } else {
                // No thermostat setting configured — count all active time
                this.heaterOnSeconds++;
            }
        }

        // Accumulate temperatures
        for (const t of temps) {
            if (t.celsius !== undefined) {
                if (!this.tempSums[t.name]) {
                    this.tempSums[t.name] = { sum: 0, count: 0 };
                }
                this.tempSums[t.name].sum += t.celsius;
                this.tempSums[t.name].count++;

                // Track min/max
                const range = this.tempRanges[t.name];
                if (range) {
                    if (t.celsius < range.min) { range.min = t.celsius; }
                    if (t.celsius > range.max) { range.max = t.celsius; }
                } else {
                    this.tempRanges[t.name] = { min: t.celsius, max: t.celsius };
                }

                // Hot sensor tracking
                if (t.name === sensorDisplayName("Hot") || t.name === "Hot") {
                    if (t.celsius >= HOT_LED_THRESHOLD) {
                        this.hotAboveThresholdSeconds++;
                    }
                    if (pumpOn) {
                        this.hotPumpSum += t.celsius;
                        this.hotPumpCount++;
                    }
                }
            }
        }

        // Record timeline point once per minute
        const d = new Date(now);
        const minute = d.getHours() * MINUTE_SECONDS + d.getMinutes();
        if (minute !== this.lastRecordedMinute) {
            const hot = findReadingByRole(temps, "Hot");
            this.timeline.record(minute, hot?.celsius, lpm, heaterActive);
            this.lastRecordedMinute = minute;
        }
    }

    public toSummary(): DaySummary {
        const avgTemps = Object.entries(this.tempSums).map(([name, { sum, count }]) => ({
            name,
            avgCelsius: count > 0 ? Math.round((sum / count) * 10) / 10 : 0,
        }));
        const tempRanges = Object.entries(this.tempRanges).map(([name, { min, max }]) => ({
            name,
            minCelsius: Math.round(min * 10) / 10,
            maxCelsius: Math.round(max * 10) / 10,
        }));
        return {
            date: this.currentDate,
            flowLiters: Math.round(this.totalFlowLiters * 10) / 10,
            pumpOnMinutes: Math.round(this.pumpOnSeconds / 6) / 10,
            pumpOnSeconds: this.pumpOnSeconds,
            heaterOnSeconds: this.heaterOnSeconds,
            avgTemps,
            tempRanges,
            hotAboveThresholdMinutes: Math.round(this.hotAboveThresholdSeconds / 6) / 10,
            hotAboveThresholdSeconds: this.hotAboveThresholdSeconds,
            hotAvgWhilePumping: this.hotPumpCount > 0
                ? Math.round((this.hotPumpSum / this.hotPumpCount) * 10) / 10
                : undefined,
            pumpEnergyKwh: PUMP_WATTS > 0
                ? Math.round((this.pumpOnSeconds * PUMP_WATTS / 3600000) * 1000) / 1000
                : undefined,
            heaterEnergyKwh: HEATER_WATTS > 0
                ? Math.round((this.heaterOnSeconds * HEATER_WATTS / 3600000) * 1000) / 1000
                : undefined,
            timeline: this.timeline.toSparse(),
        };
    }

    public getSnapshot(): StatsSnapshot {
        return {
            today: this.toSummary(),
            week: this.history.getRollingStats(7),
            month: this.history.getRollingStats(30),
        };
    }

    public close(): void {
        this.timeline.closePumpInterval(1440);
        const summary = this.toSummary();
        this.activityLogger.writeDailySummary(summary);
        this.history.upsertDay(summary);
        this.activityLogger.rotateLogs();
    }

    private reset(newDate: string): void {
        this.currentDate = newDate;
        this.totalFlowLiters = 0;
        this.pumpOnSeconds = 0;
        this.tempSums = {};
        this.tempRanges = {};
        this.hotPumpSum = 0;
        this.hotPumpCount = 0;
        this.hotAboveThresholdSeconds = 0;
        this.heaterOnSeconds = 0;
        this.timeline = new DayTimeline(newDate);
        this.lastRecordedMinute = -1;
    }
}

// ---- Logger ----

enum LogSeverity {
    Priority = 0,
    Severe = 1,
    Important = 2,
    Info = 3,
    Detail = 4
}

enum LogArea {
    None = 0,
    GPIO = "GPIO",
    Flow = "FLOW",
    General = "GENERAL",
    Serial = "SERIAL",
    Server = "SERVER",
    Temperature = "TEMP",
}

class LogItem {
    constructor(
        public readonly severity: LogSeverity,
        public readonly area: LogArea,
        public readonly error: Error | undefined,
        public readonly message: string,
        public readonly time: number
    ) { }

    public toString(): string {
        const area = this.area ? this.area.toString() : "";
        const severity = this.severity.toString();
        return `${timeString(this.time)} ${this.error !== undefined ? "!" : ""}:[${LogSeverity[severity]}](${area}) ${this.error ? this.error.message : ""} ${this.message} `;
    }
}

class Logger {
    private readonly logData: LogItem[] = [];
    public maxSeverity: LogSeverity = LogSeverity.Detail;

    public log(severity: LogSeverity, area: LogArea, message: string): void {
        const t = new LogItem(severity, area, undefined, message, Date.now());
        if (severity <= this.maxSeverity) {
            console.log(t.toString());
        }
        this.logData.push(t);
    }

    public logError(severity: LogSeverity, area: LogArea, error: Error, message = ""): void {
        const t = new LogItem(severity, area, error, message, Date.now());
        if (severity <= this.maxSeverity) {
            console.error(t.toString());
        }
        this.logData.push(t);
    }

    public fullLog(severity: LogSeverity = LogSeverity.Info): string {
        const now = new Date();
        let t = `log as of ${now.toLocaleString()} (${LogSeverity[severity]})\n`;
        this.logData.forEach((l) => {
            if (l.severity <= severity) {
                t += l.toString() + "\n";
            }
        });
        return t;
    }
}

const logger = new Logger();

// ---- Temperature Sensor ----

interface ControllerIf {
    readonly current: { celsius: number };
}

class TemperatureSensor {
    private lastCelsius: number | undefined;
    private lastChangeTime: number | undefined;
    private consecutiveErrors = 0;
    public name: string;
    public readonly deviceId: string | undefined;
    public onSignificantChange?: (name: string, oldCelsius: number, newCelsius: number) => void;

    constructor(private readonly controller: ControllerIf, public readonly index: number, name?: string, deviceId?: string) {
        this.name = name || `Sensor ${index}`;
        this.deviceId = deviceId;
    }

    /** Restore lastChangeTime from persisted history. */
    public setLastChangeTime(t: number): void {
        this.lastChangeTime = t;
    }

    public read(): number | undefined {
        try {
            const celsius = this.controller.current.celsius;
            const rounded = Math.round(celsius * 10) / 10;
            if (rounded !== this.lastCelsius) {
                const oldCelsius = this.lastCelsius;
                this.lastChangeTime = Date.now();
                this.lastCelsius = rounded;
                if (oldCelsius !== undefined && Math.abs(rounded - oldCelsius) >= TEMP_LOG_THRESHOLD && this.onSignificantChange) {
                    this.onSignificantChange(this.name, oldCelsius, rounded);
                }
            }
            if (this.consecutiveErrors > 0) {
                logger.log(LogSeverity.Info, LogArea.Temperature, `sensor ${this.index} recovered after ${this.consecutiveErrors} failed read(s)`);
                this.consecutiveErrors = 0;
            }
            return rounded;
        } catch (e) {
            this.consecutiveErrors++;
            // Intermittent single failures are common — only escalate if persistent
            const severity = this.consecutiveErrors >= 3 ? LogSeverity.Important : LogSeverity.Info;
            logger.logError(severity, LogArea.Temperature, e as Error, `sensor ${this.index} read failed (${this.consecutiveErrors} in a row)`);
            return this.lastCelsius;
        }
    }

    public get celsius(): number | undefined {
        return this.lastCelsius;
    }

    public get timeSinceLastChange(): number {
        return this.lastChangeTime !== undefined ? Date.now() - this.lastChangeTime : -1;
    }
}

// ---- Temperature Manager ----

class TemperatureManager {
    private readonly sensors: TemperatureSensor[] = [];
    private pollTimer: ReturnType<typeof setInterval> | undefined;

    constructor() {
        if (IS_LINUX) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { findDevices, fromDevice } = require('./raspi-1wire-temp/');
                const devices: string[] = findDevices() || [];
                devices.forEach((d: string, i: number) => {
                    // Extract device ID (e.g. "28-3c0af648a7f8") from path
                    const match = d.match(/(28-[0-9a-f]+)/);
                    const deviceId = match ? match[1] : undefined;
                    const role = deviceId && sensorConfig ? sensorConfig.sensors[deviceId] : undefined;
                    const name = role ? sensorDisplayName(role) : undefined;
                    this.sensors.push(new TemperatureSensor(fromDevice(d), i, name, deviceId));
                    logger.log(LogSeverity.Info, LogArea.Temperature,
                        `sensor ${i}: ${deviceId || "unknown"} → ${role || "unassigned"}`);
                });
                logger.log(LogSeverity.Important, LogArea.Temperature, `found ${devices.length} temperature sensors`);
            } catch (e) {
                const err = e as Error;
                logger.logError(LogSeverity.Important, LogArea.Temperature, err,
                    `failed to initialize temperature sensors: ${err.message}`);
            }
        } else {
            // Simulated sensors on macOS/Windows
            try {
                const { fromStream } = require('./raspi-1wire-temp/');
                const simTemps = [20.5, 21.0, 21.5, 22.0, 21.5, 21.0];
                const sim: ControllerIf = fromStream(true, ...simTemps);
                this.sensors.push(new TemperatureSensor(sim, 0, "Simulated"));
                logger.log(LogSeverity.Info, LogArea.Temperature, "using simulated temperature sensor");
            } catch (e) {
                logger.logError(LogSeverity.Info, LogArea.Temperature, e as Error, "simulated sensor unavailable");
            }
        }
    }

    public get sensorCount(): number {
        return this.sensors.length;
    }

    public start(interval: number = TEMP_POLL_INTERVAL): void {
        this.pollAll();
        this.pollTimer = setInterval(() => this.pollAll(), interval);
    }

    public stop(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    private pollAll(): void {
        for (const sensor of this.sensors) {
            sensor.read();
        }
    }

    public getSensor(index: number): TemperatureSensor | undefined {
        return this.sensors[index];
    }

    public getAllSensors(): TemperatureSensor[] {
        return [...this.sensors];
    }

    public getAllReadings(): { name: string; celsius: number | undefined; timeSinceLastChange: number }[] {
        return this.sensors.map((s) => ({
            name: s.name,
            celsius: s.celsius,
            timeSinceLastChange: s.timeSinceLastChange,
        }));
    }

    /** Check if sensor setup is needed (no config, or no Hot sensor assigned). */
    public needsSensorSetup(): boolean {
        if (!sensorConfig) { return this.sensors.length > 0; }
        const roles = Object.values(sensorConfig.sensors);
        return !roles.includes("Hot");
    }

    /** Return configured sensors that are not currently connected. */
    public getMissingSensors(): { id: string; role: string }[] {
        if (!sensorConfig) { return []; }
        const connectedIds = new Set(this.sensors.map((s) => s.deviceId).filter(Boolean));
        const missing: { id: string; role: string }[] = [];
        for (const [id, role] of Object.entries(sensorConfig.sensors)) {
            if (!connectedIds.has(id)) {
                missing.push({ id, role });
            }
        }
        return missing;
    }

    /** Rename sensors based on current sensorConfig. */
    public renameSensors(): void {
        if (!sensorConfig) { return; }
        for (const sensor of this.sensors) {
            if (sensor.deviceId && sensorConfig.sensors[sensor.deviceId]) {
                sensor.name = sensorDisplayName(sensorConfig.sensors[sensor.deviceId]);
            }
        }
    }

    /** Find a sensor by its config role (e.g. "Hot"). */
    public findByRole(role: SensorRole): TemperatureSensor | undefined {
        if (!sensorConfig) { return undefined; }
        for (const sensor of this.sensors) {
            if (sensor.deviceId && sensorConfig.sensors[sensor.deviceId] === role) {
                return sensor;
            }
        }
        return undefined;
    }
}

/** Find a reading by role in a {name, celsius} array. Works with localized names. */
function findReadingByRole<T extends { name: string }>(readings: T[], role: SensorRole): T | undefined {
    const localizedName = sensorDisplayName(role);
    return readings.find((r) => r.name === localizedName || r.name === role);
}

// ---- Flow Sensor ----

class FlowSensor {
    private lastFlow = 0;
    private lastChangeTime: number | undefined;
    private _flowStartTime: number | undefined;
    private pollTimer: ReturnType<typeof setInterval> | undefined;
    private staleTimer: ReturnType<typeof setTimeout> | undefined;
    private stopDebounceTimer: ReturnType<typeof setTimeout> | undefined;
    private monitorProc: ChildProcess | undefined;
    public onFlowChange?: (started: boolean, lpm: number) => void;
    private gpioError: string | undefined;

    private static readonly STOP_DEBOUNCE_MS = 500; // ignore flow gaps shorter than this

    constructor() {
    }

    /** Restore lastChangeTime from persisted history. */
    public setLastChangeTime(t: number): void {
        this.lastChangeTime = t;
    }

    private initGpio(): void {
        try {
            let lastPulseTime = Date.now();

            this.monitorProc = spawn("gpiomon", [
                "--chip", "0", "--edges", "both", "--format", "%e", String(SENSOR_PIN)
            ]);

            this.monitorProc.stdout?.on("data", (data: Buffer) => {
                // Each line is "1" (rising) or "2" (falling)
                const lines = data.toString().trim().split("\n");
                for (const _line of lines) {
                    const now = Date.now();
                    const pw = now - lastPulseTime;
                    lastPulseTime = now;
                    this.updateFlow(pwToFlow(pw));
                    this.resetStaleTimer();
                }
            });

            this.monitorProc.stderr?.on("data", (data: Buffer) => {
                const msg = data.toString().trim();
                logger.log(LogSeverity.Detail, LogArea.GPIO, `gpiomon stderr: ${msg}`);
                this.gpioError = msg;
            });

            this.monitorProc.on("exit", (code) => {
                if (code !== null && code !== 0) {
                    logger.log(LogSeverity.Important, LogArea.GPIO, `gpiomon exited with code ${code}`);
                    this.gpioError = `gpiomon exited with code ${code}`;
                }
                this.monitorProc = undefined;
            });

            logger.log(LogSeverity.Important, LogArea.GPIO, `monitoring flow on BCM pin ${SENSOR_PIN} via gpiomon`);
        } catch (e) {
            logger.logError(LogSeverity.Important, LogArea.GPIO, e as Error, "failed to initialize GPIO");
            this.gpioError = (e as Error).message;
        }
    }

    /** Check if gpiomon started successfully. Call after a short delay. */
    public async checkGpio(): Promise<string | undefined> {
        if (!IS_LINUX) {
            return undefined; // not applicable on non-Linux
        }
        // Give gpiomon time to fail if it's going to
        await sleep(500);
        return this.gpioError;
    }

    public start(interval: number = FLOW_POLL_INTERVAL): void {
        if (IS_LINUX) {
            this.initGpio();
        } else {
            logger.log(LogSeverity.Info, LogArea.Flow, "using simulated flow sensor");
        }
        if (!IS_LINUX) {
            // Simulate flow changes on non-Linux
            let simPhase = 0;
            this.pollTimer = setInterval(() => {
                simPhase = (simPhase + 1) % 120;
                // Simulate: 0 flow most of the time, occasional flow burst
                if (simPhase >= 20 && simPhase <= 40) {
                    const flow = 3.0 + Math.sin(simPhase * 0.3) * 1.5;
                    this.updateFlow(Math.round(flow * 100) / 100);
                } else {
                    this.updateFlow(0);
                }
            }, interval);
        }
    }

    private resetStaleTimer(): void {
        if (this.staleTimer) {
            clearTimeout(this.staleTimer);
        }
        this.staleTimer = setTimeout(() => {
            this.updateFlow(0);
            this.staleTimer = undefined;
        }, 2 * SECOND);
    }

    public stop(): void {
        if (this.staleTimer) {
            clearTimeout(this.staleTimer);
            this.staleTimer = undefined;
        }
        if (this.stopDebounceTimer) {
            clearTimeout(this.stopDebounceTimer);
            this.stopDebounceTimer = undefined;
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        if (this.monitorProc) {
            try {
                this.monitorProc.kill();
                this.monitorProc = undefined;
            } catch (_) {
                // ignore cleanup errors
            }
        }
    }

    private updateFlow(flow: number): void {
        if (flow === 0 && this.lastFlow > 0) {
            // Debounce: don't update lastFlow to 0 immediately — wait to confirm flow actually stopped
            if (!this.stopDebounceTimer) {
                this.lastChangeTime = Date.now();
                this.stopDebounceTimer = setTimeout(() => {
                    this.stopDebounceTimer = undefined;
                    if (this.lastFlow > 0) {
                        // Still debouncing (no new pulse arrived) — now commit the stop
                        this.lastFlow = 0;
                        this._flowStartTime = undefined;
                        if (this.onFlowChange) {
                            this.onFlowChange(false, 0);
                        }
                    }
                }, FlowSensor.STOP_DEBOUNCE_MS);
            }
        } else if (flow > 0) {
            const wasZero = this.lastFlow === 0 && !this.stopDebounceTimer;
            // Cancel any pending stop debounce — flow is still active
            if (this.stopDebounceTimer) {
                clearTimeout(this.stopDebounceTimer);
                this.stopDebounceTimer = undefined;
            }
            if (flow !== this.lastFlow) {
                this.lastChangeTime = Date.now();
            }
            this.lastFlow = flow;
            if (wasZero) {
                this._flowStartTime = Date.now();
                if (this.onFlowChange) {
                    this.onFlowChange(true, flow);
                }
            }
        }
    }

    public get lpm(): number {
        return this.lastFlow;
    }

    public get flowStartTime(): number | undefined {
        return this._flowStartTime;
    }

    public get timeSinceLastChange(): number {
        return this.lastChangeTime !== undefined ? Date.now() - this.lastChangeTime : -1;
    }
}

// ---- Pump ----

class Pump {
    private _state = false;
    private _source: PumpSource;
    private lastChangeTime: number | undefined;
    private gpioProc: ChildProcess | undefined;
    public onStateChange?: (on: boolean, source: PumpSource) => void;

    constructor() {
        if (IS_LINUX) {
            logger.log(LogSeverity.Important, LogArea.GPIO, `pump output on BCM pin ${PUMP_PIN} via gpioset`);
        }
    }

    private writeGpio(on: boolean): void {
        if (!IS_LINUX) {
            return;
        }
        try {
            // Kill previous gpioset so it releases the line
            if (this.gpioProc) {
                this.gpioProc.kill("SIGKILL");
                this.gpioProc = undefined;
            }
            // Spawn gpioset to hold the pin at the desired value
            this.gpioProc = spawn("gpioset", ["--chip", "0", `${PUMP_PIN}=${on ? 1 : 0}`]);
        } catch (e) {
            logger.logError(LogSeverity.Important, LogArea.GPIO, e as Error, "pump GPIO write failed");
        }
    }

    public shutdown(): void {
        // Kill the holder — line goes high-Z, relay de-energises (pump off)
        if (this.gpioProc) {
            this.gpioProc.kill("SIGKILL");
            this.gpioProc = undefined;
        }
    }

    public get state(): boolean {
        return this._state;
    }

    public get source(): PumpSource {
        return this._source;
    }

    public setState(on: boolean, source?: PumpSource): void {
        if (on !== this._state) {
            this._state = on;
            this._source = on ? source : undefined;
            this.lastChangeTime = Date.now();
            this.writeGpio(on);
            const sourceLabel = this._source ? ` (${this._source})` : "";
            logger.log(LogSeverity.Important, LogArea.General, `pump ${on ? "ON" : "OFF"}${sourceLabel}`);
            if (this.onStateChange) {
                this.onStateChange(on, this._source);
            }
        }
    }

    /** Restore lastChangeTime from persisted history. */
    public setLastChangeTime(t: number): void {
        this.lastChangeTime = t;
    }

    public get timeSinceLastChange(): number {
        return this.lastChangeTime !== undefined ? Date.now() - this.lastChangeTime : -1;
    }
}

// ---- Water Heater ----

/** Tracks whether the tankless water heater is active.
 *  Defaults to flow-based detection; can be overridden by an external sensor signal. */
class WaterHeater {
    private _sensorActive: boolean | undefined;

    constructor(private readonly flow: FlowSensor, private readonly pump: Pump) { }

    /** Set heater state from an external sensor. Pass undefined to revert to flow-based detection. */
    public setSensorState(active: boolean | undefined): void {
        this._sensorActive = active;
    }

    /** True if an external sensor is providing heater state. */
    public get hasSensor(): boolean {
        return this._sensorActive !== undefined;
    }

    /** Whether the heater is currently active. Uses external sensor if available, otherwise flow/pump-based. */
    public get active(): boolean {
        return this._sensorActive !== undefined ? this._sensorActive : (this.flow.lpm > 0 || this.pump.state);
    }
}

// ---- Pump Controller ----

class PumpController {
    private pollTimer: ReturnType<typeof setInterval> | undefined;
    private userOverride = false;
    private lastZeroFlowTime: number | undefined;
    public onTick?: () => void;

    constructor(
        private readonly pump: Pump,
        private readonly flow: FlowSensor
    ) { }

    public start(interval: number = SECOND): void {
        this.pollTimer = setInterval(() => this.tick(), interval);
    }

    public stop(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }

    public userSetPump(on: boolean): void {
        if (!on && this.pump.source === "auto") {
            this.userOverride = true;
        }
        if (on) {
            this.userOverride = false;
        }
        this.pump.setState(on, "user");
    }

    private tick(): void {
        const now = Date.now();

        // Always fire onTick so stats/timeline are recorded regardless of pump state
        if (this.onTick) {
            this.onTick();
        }

        // Track when flow goes to zero
        if (this.flow.lpm === 0) {
            if (this.lastZeroFlowTime === undefined) {
                this.lastZeroFlowTime = now;
            }
        } else {
            this.lastZeroFlowTime = undefined;
        }

        const flowStoppedFor = this.lastZeroFlowTime !== undefined
            ? now - this.lastZeroFlowTime
            : 0;

        // 1. Max run time safety cutoff (highest priority)
        if (this.pump.state && this.pump.timeSinceLastChange >= PUMP_MAX_RUN_TIME) {
            logger.log(LogSeverity.Important, LogArea.General, "pump safety shutoff: max run time exceeded");
            this.pump.setState(false);
            this.userOverride = true; // prevent auto re-engage until flow stops
            return;
        }

        // 2. User override active: wait for flow to fully stop before clearing
        if (this.userOverride) {
            if (flowStoppedFor >= FLOW_STOP_DELAY) {
                this.userOverride = false;
            }
            return;
        }

        // 3. Auto-on: flow has persisted long enough
        if (!this.pump.state) {
            const flowStart = this.flow.flowStartTime;
            if (flowStart !== undefined && now - flowStart >= FLOW_START_DELAY) {
                this.pump.setState(true, "auto");
            }
            return;
        }

        // 4. Auto-off: pump is on via auto and flow has stopped
        if (this.pump.state && this.pump.source === "auto") {
            if (flowStoppedFor >= FLOW_STOP_DELAY) {
                this.pump.setState(false);
            }
        }
    }
}

// ---- Status LEDs ----

type LedErrorCondition = "noTemperature" | "noLoopback" | "noConnection" | "noGateway" | "other";

class StatusLEDs {
    // One gpioset process per pin — tracked here so we can always kill it
    private readonly pinProcs = new Map<number, ChildProcess>();
    private flowBlinkTimer: ReturnType<typeof setInterval> | undefined;
    private flowBlinkState = false;
    private lastHotLedOn: boolean | undefined;
    private lastPumpLedOn: boolean | undefined;
    private lastFlowLpm: number | undefined;
    private animationTimer: ReturnType<typeof setInterval> | undefined;
    private _mode: "off" | "cycling" | "error" | "normal" = "off";
    private _errorCondition: LedErrorCondition | undefined;

    public get mode(): "off" | "cycling" | "error" | "normal" {
        return this._mode;
    }

    public get errorCondition(): LedErrorCondition | undefined {
        return this._errorCondition;
    }

    private setPin(pin: number, on: boolean): void {
        // Kill the previous holder for this pin so the line is released
        const prev = this.pinProcs.get(pin);
        if (prev) {
            try { prev.kill("SIGKILL"); } catch (_) { /* ignore */ }
            this.pinProcs.delete(pin);
        }
        if (!IS_LINUX) {
            return;
        }
        try {
            const proc = spawn("gpioset", ["--chip", "0", `${pin}=${on ? 1 : 0}`]);
            this.pinProcs.set(pin, proc);
            proc.on("exit", () => {
                // Remove from map if it's still the current holder
                if (this.pinProcs.get(pin) === proc) {
                    this.pinProcs.delete(pin);
                }
            });
        } catch (e) {
            logger.logError(LogSeverity.Important, LogArea.GPIO, e as Error, `LED gpioset pin ${pin} failed`);
        }
    }

    private killAllPins(): void {
        for (const [pin, proc] of this.pinProcs) {
            try { proc.kill("SIGKILL"); } catch (_) { /* ignore */ }
        }
        this.pinProcs.clear();
    }

    /** Drive all LED pins low, wait briefly for the value to latch, then kill
     *  the holders so no orphaned gpioset processes remain after process.exit(). */
    public allOff(): void {
        // Kill any existing holders first
        this.killAllPins();
        if (!IS_LINUX) { return; }
        // Spawn gpioset in default (hold) mode to drive each pin low
        const procs: ChildProcess[] = [];
        for (const pin of [HOT_LED_PIN, FLOW_LED_PIN, PUMP_LED_PIN]) {
            try {
                const proc = spawn("gpioset", ["--chip", "0", `${pin}=0`]);
                procs.push(proc);
            } catch { /* ignore */ }
        }
        // Wait briefly for gpioset to grab the lines and set them low
        spawnSync("sleep", ["0.1"]);
        // Kill the holders — the pin values are latched by hardware
        for (const proc of procs) {
            try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        }
    }

    public startCycling(): void {
        this.stopAnimation();
        this._mode = "cycling";
        const pins = [HOT_LED_PIN, FLOW_LED_PIN, PUMP_LED_PIN];
        let step = 0;

        const cycle = () => {
            for (let i = 0; i < 3; i++) {
                this.setPin(pins[i], i === step % 3);
            }
            step++;
        };
        cycle();
        this.animationTimer = setInterval(cycle, 300);
    }

    public startErrorFlash(condition: LedErrorCondition = "other"): void {
        this.stopAnimation();
        this._mode = "error";
        this._errorCondition = condition;
        let on = false;

        // Explicitly turn off all LEDs before starting the error pattern,
        // since GPIO lines may float high after killAllPins on some hardware.
        this.allOff()

        switch (condition) {
            case "noTemperature": {
                // Flash only the HOT LED quickly
                const flash = () => { on = !on; this.setPin(HOT_LED_PIN, on); };
                flash();
                this.animationTimer = setInterval(flash, 200);
                break;
            }
            case "noLoopback": {
                // Flash only the FLOW LED quickly
                const flash = () => { on = !on; this.setPin(FLOW_LED_PIN, on); };
                flash();
                this.animationTimer = setInterval(flash, 200);
                break;
            }
            case "noConnection": {
                // Flash PUMP and HOT LEDs quickly in unison
                const flash = () => { on = !on; this.setPin(PUMP_LED_PIN, on); this.setPin(HOT_LED_PIN, on); };
                flash();
                this.animationTimer = setInterval(flash, 200);
                break;
            }
            case "noGateway": {
                // Flash PUMP and HOT LEDs slowly in unison
                const flash = () => { on = !on; this.setPin(PUMP_LED_PIN, on); this.setPin(HOT_LED_PIN, on); };
                flash();
                this.animationTimer = setInterval(flash, 800);
                break;
            }
            default: {
                // Flash all LEDs
                const pins = [HOT_LED_PIN, FLOW_LED_PIN, PUMP_LED_PIN];
                const flash = () => { on = !on; for (const pin of pins) { this.setPin(pin, on); } };
                flash();
                this.animationTimer = setInterval(flash, 500);
                break;
            }
        }
    }

    public stopAnimation(): void {
        if (this.animationTimer) {
            clearInterval(this.animationTimer);
            this.animationTimer = undefined;
        }
        if (this.flowBlinkTimer) {
            clearInterval(this.flowBlinkTimer);
            this.flowBlinkTimer = undefined;
        }
        // Kill all pin holders — lines go high-Z, LEDs turn off
        this.killAllPins();
        // Reset cached states so normal updates take effect
        this.lastHotLedOn = undefined;
        this.lastPumpLedOn = undefined;
        this.lastFlowLpm = undefined;
    }

    public enterNormalMode(): void {
        this.stopAnimation();
        this._mode = "normal";
    }

    public updateHotLed(celsius: number | undefined): void {
        const on = celsius !== undefined && celsius >= HOT_LED_THRESHOLD;
        if (on === this.lastHotLedOn) {
            return;
        }
        this.lastHotLedOn = on;
        this.setPin(HOT_LED_PIN, on);
    }

    public updatePumpLed(on: boolean): void {
        if (on === this.lastPumpLedOn) {
            return;
        }
        this.lastPumpLedOn = on;
        this.setPin(PUMP_LED_PIN, on);
    }

    private flowBlinkCategory(lpm: number): number {
        // 0 = no flow, 1 = slow blink (<1 lpm), 2 = fast blink (>=1 lpm)
        if (lpm === 0) { return 0; }
        return lpm < 1 ? 1 : 2;
    }

    public updateFlowLed(lpm: number): void {
        const category = this.flowBlinkCategory(lpm);
        const lastCategory = this.lastFlowLpm !== undefined ? this.flowBlinkCategory(this.lastFlowLpm) : -1;
        if (category === lastCategory) {
            return;
        }
        this.lastFlowLpm = lpm;

        // Stop any existing blink timer
        if (this.flowBlinkTimer) {
            clearInterval(this.flowBlinkTimer);
            this.flowBlinkTimer = undefined;
        }

        if (category === 0) {
            // Off — kill holder, line goes high-Z, LED off
            this.flowBlinkState = false;
            this.setPin(FLOW_LED_PIN, false);
        } else {
            // Blink: slow (600ms) if < 1 lpm, fast (200ms) if >= 1 lpm
            const interval = category === 1 ? 600 : 200;
            this.flowBlinkState = true;
            this.setPin(FLOW_LED_PIN, true);
            this.flowBlinkTimer = setInterval(() => {
                this.flowBlinkState = !this.flowBlinkState;
                this.setPin(FLOW_LED_PIN, this.flowBlinkState);
            }, interval);
        }
    }

    public stop(): void {
        this.stopAnimation();
        this._mode = "off";
    }
}

// ---- Door Monitor ----

/** Door state event from wireless module. */
interface DoorEvent {
    doorId: number;
    name: string;
    type: "open" | "close";
    /** Seconds the door was open (for "open" events), 99 = still open per protocol. */
    openSeconds?: number;
    time: number;
}

/** Status info from a door sensor (battery, CPU, serial, version). */
interface SensorStatus {
    sensorId: number;
    batteryMv?: number;        // millivolts
    cpuUptime?: number;        // seconds
    serialUptime?: number;     // seconds
    version?: number;          // 0xxx = prod, 1xxx = test
    lastSeen: number;          // ms timestamp
}

const SERIAL_DEVICE = "/dev/serial0";
const SERIAL_BAUD = 9600;

/**
 * Monitors door open/close events via a serial wireless module connected
 * to the Raspberry Pi UART (RXD/TXD GPIO pins).
 *
 * Protocol: 9600 baud, OYU message format:
 *   "OYU:ii:VERB:data:seq|xsum\n"
 * Verbs: OPEN, CLOSE, BAT, CPU, SER, VER
 * ACK: echo back with "OYU" → "UYO" and recalculated checksum.
 * Duplicate sequence numbers (same sensor, same seq) are silently discarded.
 * See door_sensor_protocol.md for full specification.
 */
class DoorMonitor {
    private serialProcess: ReturnType<typeof spawn> | undefined;
    private buffer = "";
    private readonly events: DoorEvent[] = [];
    private readonly maxEvents = 500;
    /** Last received sequence number per sensor ID, for duplicate detection. */
    private readonly lastSeq = new Map<number, number>();
    /** Status info per sensor (battery, uptime, version). */
    private readonly sensorStatus = new Map<number, SensorStatus>();
    public onEvent?: (event: DoorEvent) => void;

    /** Start listening on the serial port. Only works on Linux. */
    public start(): void {
        if (!IS_LINUX || !DOOR_MONITOR_ENABLED) { return; }

        // Configure HC12 channel via AT command mode (runs stty internally)
        this.configureHC12Channel();

        // Start the serial reader — cat with auto-restart if it exits
        this.startSerialReader();

        logger.log(LogSeverity.Info, LogArea.Serial,
            `door monitor started on ${SERIAL_DEVICE} channel ${HC12_SERIAL_CHANNEL} @ ${SERIAL_BAUD} baud`);
    }

    private stopped = false;

    /** Start cat on the serial device, with auto-restart on exit. */
    private startSerialReader(): void {
        // Re-apply stty raw before each cat start
        try {
            execSync(`stty -F ${SERIAL_DEVICE} ${SERIAL_BAUD} raw -echo`, { timeout: 5000, stdio: "pipe" });
        } catch { /* ExecStartPre handles this if we can't */ }

        this.serialProcess = spawn("cat", [SERIAL_DEVICE], { stdio: ["ignore", "pipe", "pipe"] });

        this.serialProcess.stdout?.on("data", (chunk: Buffer) => {
            const data = chunk.toString("utf-8");
            //logger.log(LogSeverity.Detail, LogArea.Serial,`serial rx (${chunk.length} bytes): ${JSON.stringify(data)}`);
            this.buffer += data;
            this.parseBuffer();
        });

        this.serialProcess.stderr?.on("data", (chunk: Buffer) => {
            logger.log(LogSeverity.Important, LogArea.Serial,
                `cat stderr: ${chunk.toString().trim()}`);
        });

        this.serialProcess.on("error", (err) => {
            logger.logError(LogSeverity.Severe, LogArea.Serial, err,
                `serial port error on ${SERIAL_DEVICE}`);
        });

        this.serialProcess.on("exit", (code) => {
            this.serialProcess = undefined;
            if (this.stopped) { return; }
            logger.log(LogSeverity.Info, LogArea.Serial,
                `serial reader exited with code ${code}, restarting in 1s`);
            setTimeout(() => {
                if (!this.stopped) { this.startSerialReader(); }
            }, 1000);
        });
    }

    /** Set the HC12 wireless module to the configured channel via AT commands.
     *  All serial I/O uses shell commands (via ExecStartPre stty config).
     *  Pulls the SET pin LOW to enter AT mode, sends the channel command, then
     *  re-applies stty raw mode and releases the pin back to HIGH. */
    private configureHC12Channel(): void {
        const channel = String(HC12_SERIAL_CHANNEL).padStart(3, "0");
        let setProc: ReturnType<typeof spawn> | undefined;
        try {
            // Pull SET pin LOW to enter AT command mode
            setProc = spawn("gpioset", ["--chip", "0", `${HC12_SET_PIN}=0`]);
            // HC12 needs ~40ms to enter AT mode
            execSync("sleep 0.1", { timeout: 2000 });

            // Send AT channel command and discard response — all via shell to avoid
            // Node file I/O which resets terminal settings on tty devices
            try {
                execSync(
                    `echo -ne "AT+C${channel}\\r\\n" > ${SERIAL_DEVICE}`,
                    { timeout: 2000, stdio: "pipe" });
                execSync("sleep 0.2", { timeout: 2000 });
            } catch { /* best effort */ }
            logger.log(LogSeverity.Info, LogArea.Serial,
                `HC12 channel set to ${HC12_SERIAL_CHANNEL}`);
        } catch (e) {
            logger.logError(LogSeverity.Important, LogArea.Serial, e as Error,
                `failed to configure HC12 channel ${HC12_SERIAL_CHANNEL}`);
        } finally {
            // Kill the LOW holder and drive SET pin HIGH to exit AT mode
            if (setProc) { setProc.kill(); }
            try {
                const highProc = spawn("gpioset", ["--chip", "0", `${HC12_SET_PIN}=1`]);
                execSync("sleep 0.05", { timeout: 2000 });
                highProc.kill();
            } catch { /* best effort */ }
            // Re-apply raw mode — the echo/shell commands above reset terminal settings
            try {
                execSync(`stty -F ${SERIAL_DEVICE} ${SERIAL_BAUD} raw -echo`,
                    { timeout: 5000, stdio: "pipe" });
            } catch (e) {
                logger.logError(LogSeverity.Important, LogArea.Serial, e as Error,
                    `stty re-apply failed after HC12 config`);
            }
        }
    }

    public stop(): void {
        this.stopped = true;
        if (this.serialProcess) {
            this.serialProcess.kill();
            this.serialProcess = undefined;
        }
    }

    public get isRunning(): boolean {
        return this.serialProcess !== undefined;
    }

    public getRecentEvents(count = 20): readonly DoorEvent[] {
        return this.events.slice(-count);
    }

    /** Get the current state of all known doors. */
    public getDoorStates(): { doorId: number; name: string; lastEvent: DoorEvent }[] {
        const latest = new Map<number, DoorEvent>();
        for (const ev of this.events) {
            latest.set(ev.doorId, ev);
        }
        return Array.from(latest.entries())
            .sort(([a], [b]) => a - b)
            .map(([doorId, ev]) => ({ doorId, name: ev.name, lastEvent: ev }));
    }

    /** Get status info for all known sensors. */
    public getAllSensorStatus(): ReadonlyMap<number, SensorStatus> {
        return this.sensorStatus;
    }

    /** Feed raw serial data into the buffer for processing (used for testing). */
    public feedData(data: string): void {
        this.buffer += data;
        this.parseBuffer();
    }

    /** Compute XOR checksum of all bytes in a string, returned as 2-digit hex. */
    public static xorChecksum(data: string): string {
        let xor = 0;
        for (let i = 0; i < data.length; i++) {
            xor ^= data.charCodeAt(i);
        }
        return xor.toString(16).padStart(2, "0").toUpperCase();
    }

    /** Send an ACK back over the serial port via shell to preserve tty settings.
     *  ACK format: replace "OYU" with "UYO", recalculate checksum. */
    private sendAck(msgBeforePipe: string): void {
        const ackBody = "UYO" + msgBeforePipe.slice(3); // replace OYU with UYO
        const ackXsum = DoorMonitor.xorChecksum(ackBody);
        const ack = `${ackBody}|${ackXsum}\n`;
        try {
            execSync(`echo -ne "${ack.replace(/"/g, '\\"')}" > ${SERIAL_DEVICE}`, { timeout: 2000, stdio: "pipe" });
            execSync(`stty -F ${SERIAL_DEVICE} ${SERIAL_BAUD} raw -echo`, { timeout: 2000, stdio: "pipe" });
            logger.log(LogSeverity.Detail, LogArea.Serial, `ACK sent: ${ack.trim()}`);
        } catch (e) {
            logger.logError(LogSeverity.Important, LogArea.Serial, e as Error, "failed to send ACK");
        }
    }

    private parseBuffer(): void {
        // Process complete newline-terminated messages from the buffer
        let nlIdx: number;
        while ((nlIdx = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, nlIdx).replace(/\r$/, "");
            this.buffer = this.buffer.slice(nlIdx + 1);
            if (line.startsWith("OYU:")) {
                this.processMessage(line);
            }
        }
        // Prevent unbounded buffer growth from non-OYU data
        if (this.buffer.length > 1024) {
            this.buffer = this.buffer.slice(-256);
        }
    }

    /** Validate and process a single OYU protocol message. */
    private processMessage(line: string): void {
        // Validate length
        if (line.length > 32) {
            logger.log(LogSeverity.Detail, LogArea.Serial, `message too long (${line.length}): ${line}`);
            return;
        }

        // Split body and checksum on |
        const pipeIdx = line.indexOf("|");
        if (pipeIdx === -1) {
            logger.log(LogSeverity.Detail, LogArea.Serial, `no checksum separator: ${line}`);
            return;
        }
        const body = line.slice(0, pipeIdx);
        const xsum = line.slice(pipeIdx + 1);

        // Validate checksum
        const expected = DoorMonitor.xorChecksum(body);
        if (xsum.toUpperCase() !== expected) {
            logger.log(LogSeverity.Info, LogArea.Serial,
                `bad checksum: expected ${expected}, got ${xsum} in: ${line}`);
            return;
        }

        // Parse fields: OYU:ii:VERB:data:seq
        const parts = body.split(":");
        if (parts.length < 4) {
            logger.log(LogSeverity.Detail, LogArea.Serial, `too few fields: ${line}`);
            return;
        }

        const sensorIdStr = parts[1];
        const verb = parts[2];
        if (!/^\d{2}$/.test(sensorIdStr)) {
            logger.log(LogSeverity.Detail, LogArea.Serial, `invalid sensor ID: ${line}`);
            return;
        }
        if (!VALID_OYU_VERBS.has(verb)) {
            logger.log(LogSeverity.Detail, LogArea.Serial, `unknown verb "${verb}": ${line}`);
            return;
        }

        const sensorId = parseInt(sensorIdStr, 10);
        const name = DOOR_NAMES[String(sensorId)] || `Sensor ${sensorId}`;
        const now = Date.now();

        // Extract sequence number (always last field before |)
        const seqStr = parts[parts.length - 1];
        if (!/^\d{2}$/.test(seqStr)) {
            logger.log(LogSeverity.Detail, LogArea.Serial, `invalid seq: ${line}`);
            return;
        }
        const seq = parseInt(seqStr, 10);

        // Duplicate detection
        if (this.lastSeq.get(sensorId) === seq) {
            logger.log(LogSeverity.Detail, LogArea.Serial,
                `duplicate ignored: sensor ${sensorId} seq ${seq}`);
            return;
        }
        this.lastSeq.set(sensorId, seq);

        // Send ACK
        this.sendAck(body);

        // Data field(s) are between verb and seq
        const dataFields = parts.slice(3, -1);
        const data = dataFields.join(":");

        // Ensure sensor status entry exists
        let status = this.sensorStatus.get(sensorId);
        if (!status) {
            status = { sensorId, lastSeen: now };
            this.sensorStatus.set(sensorId, status);
        }
        status.lastSeen = now;

        switch (verb) {
            case "OPEN": {
                const seconds = parseInt(data, 10);
                if (isNaN(seconds) || seconds < 0 || (seconds > 59 && seconds !== DOOR_STILL_OPEN_SENTINEL)) {
                    logger.log(LogSeverity.Info, LogArea.Serial, `invalid OPEN seconds "${data}": ${line}`);
                    return;
                }
                this.addEvent({ doorId: sensorId, name, type: "open", openSeconds: seconds, time: now });
                break;
            }
            case "CLOSE": {
                this.addEvent({ doorId: sensorId, name, type: "close", time: now });
                break;
            }
            case "BAT": {
                const mv = parseInt(data, 10);
                if (!isNaN(mv)) {
                    status.batteryMv = mv;
                    logger.log(LogSeverity.Info, LogArea.Serial,
                        `sensor ${sensorId} battery: ${mv}mV`);
                }
                break;
            }
            case "CPU": {
                const uptime = parseInt(data, 10);
                if (!isNaN(uptime)) {
                    status.cpuUptime = uptime;
                    logger.log(LogSeverity.Detail, LogArea.Serial,
                        `sensor ${sensorId} CPU uptime: ${uptime}s`);
                }
                break;
            }
            case "SER": {
                const uptime = parseInt(data, 10);
                if (!isNaN(uptime)) {
                    status.serialUptime = uptime;
                    logger.log(LogSeverity.Detail, LogArea.Serial,
                        `sensor ${sensorId} serial uptime: ${uptime}s`);
                }
                break;
            }
            case "VER": {
                const ver = parseInt(data, 10);
                if (!isNaN(ver)) {
                    status.version = ver;
                    logger.log(LogSeverity.Info, LogArea.Serial,
                        `sensor ${sensorId} version: ${ver} (${ver >= 1000 ? "test" : "prod"})`);
                }
                break;
            }
        }
    }

    private addEvent(event: DoorEvent): void {
        this.events.push(event);
        if (this.events.length > this.maxEvents) {
            this.events.splice(0, this.events.length - this.maxEvents);
        }
        logger.log(LogSeverity.Info, LogArea.Serial,
            event.type === "open"
                ? `${event.name} opened (${event.openSeconds}s${event.openSeconds === DOOR_STILL_OPEN_SENTINEL ? " — left open" : ""})`
                : `${event.name} closed`);
        this.onEvent?.(event);
    }
}

// ---- Sensor Manager ----

class SensorManager {
    public readonly temperature: TemperatureManager;
    public readonly flow: FlowSensor;
    public readonly pump: Pump;
    public readonly heater: WaterHeater;
    public readonly pumpController: PumpController;
    public readonly statusLEDs: StatusLEDs;
    public readonly doorMonitor: DoorMonitor;
    private readonly startTime: number;
    private periodicSaveTimer: ReturnType<typeof setInterval> | undefined;
    public onChange?: () => void;
    public readonly activityLogger: ActivityLogger;
    public readonly historyStore: HistoryStore;
    public readonly statsAccumulator: StatsAccumulator;

    constructor(logDir?: string) {
        this.startTime = Date.now();
        const dir = logDir || ".";
        this.activityLogger = new ActivityLogger(dir);
        this.historyStore = new HistoryStore(join(dir, HISTORY_FILE));
        this.statsAccumulator = new StatsAccumulator(this.activityLogger, this.historyStore);

        this.temperature = new TemperatureManager();
        this.flow = new FlowSensor();
        this.pump = new Pump();
        this.heater = new WaterHeater(this.flow, this.pump);
        this.pumpController = new PumpController(this.pump, this.flow);
        this.statusLEDs = new StatusLEDs();
        this.doorMonitor = new DoorMonitor();

        // Restore last state change times from activity log
        const lastChanges = readLastStateChanges(this.activityLogger.logPath);
        if (lastChanges.temp !== undefined) {
            for (const sensor of this.temperature.getAllSensors()) {
                sensor.setLastChangeTime(lastChanges.temp);
            }
        }
        if (lastChanges.flow !== undefined) {
            this.flow.setLastChangeTime(lastChanges.flow);
        }
        if (lastChanges.pump !== undefined) {
            this.pump.setLastChangeTime(lastChanges.pump);
        }

        // Wire callbacks
        this.pump.onStateChange = (on, source) => {
            this.activityLogger.logPumpChange(on, source);
            const now = new Date();
            const minute = now.getHours() * MINUTE_SECONDS + now.getMinutes();
            this.statsAccumulator.timeline.pumpChanged(on, minute);
            if (this.statusLEDs.mode === "normal") {
                this.statusLEDs.updatePumpLed(on);
            }
        };

        this.flow.onFlowChange = (started, lpm) => {
            this.activityLogger.logFlowChange(started, lpm);
            if (this.statusLEDs.mode === "normal") {
                this.statusLEDs.updateFlowLed(lpm);
            }
        };

        for (const sensor of this.temperature.getAllSensors()) {
            sensor.onSignificantChange = (name, oldC, newC) => {
                this.activityLogger.logTemperatureChange(name, oldC, newC);
                if (name === "Hot" && this.statusLEDs.mode === "normal") {
                    this.statusLEDs.updateHotLed(newC);
                }
            };
        }

        this.pumpController.onTick = () => {
            const temps = this.temperature.getAllReadings().map((r) => ({
                name: r.name,
                celsius: r.celsius,
            }));
            this.statsAccumulator.tick(this.flow.lpm, this.pump.state, temps, this.heater.active);

            if (this.statusLEDs.mode === "normal") {
                // Update HOT LED on every tick based on current Hot sensor reading
                const hot = findReadingByRole(temps, "Hot");
                this.statusLEDs.updateHotLed(hot?.celsius);
            }
        };
    }

    public start(): void {
        this.temperature.start();
        this.flow.start();
        this.pumpController.start();
        this.doorMonitor.start();
        // Save history every 15 minutes to protect timeline data against power loss
        this.periodicSaveTimer = setInterval(() => {
            const summary = this.statsAccumulator.toSummary();
            this.historyStore.upsertDay(summary);
        }, 15 * MINUTE);
    }

    public stop(): void {
        if (this.periodicSaveTimer) {
            clearInterval(this.periodicSaveTimer);
            this.periodicSaveTimer = undefined;
        }
        this.pumpController.stop();
        this.temperature.stop();
        this.flow.stop();
        this.doorMonitor.stop();
        this.pump.shutdown();
        this.statsAccumulator.close();
        this.statusLEDs.stop();
        this.statusLEDs.allOff();
    }

    public getStatus(): StatusResponse {
        // Find the most recent open event per door
        const lastOpen = new Map<number, DoorEvent>();
        for (const ev of this.doorMonitor.getRecentEvents(500)) {
            if (ev.type === "open") { lastOpen.set(ev.doorId, ev); }
        }
        const doorStates: DoorState[] = this.doorMonitor.getDoorStates().map(d => {
            const openEv = lastOpen.get(d.doorId);
            const openTime = openEv ? openEv.time - (openEv.openSeconds ?? 0) * 1000 : 0;
            // Door is still open if the latest event is OPEN with sentinel value 99 (no CLOSE followed)
            const stillOpen = d.lastEvent.type === "open"
                && d.lastEvent.openSeconds === DOOR_STILL_OPEN_SENTINEL;
            // If closed after being left open, calculate actual duration from open time to close time
            let lastOpenSeconds = openEv?.openSeconds ?? 0;
            if (d.lastEvent.type === "close" && openEv && openTime > 0) {
                lastOpenSeconds = Math.round((d.lastEvent.time - openTime) / 1000);
            }
            return {
                doorId: d.doorId,
                name: d.name,
                lastOpenTime: openTime,
                lastOpenSeconds,
                stillOpen,
            };
        });
        return {
            time: Date.now(),
            temperature: this.temperature.getAllReadings(),
            flow: {
                lpm: this.flow.lpm,
                timeSinceLastChange: this.flow.timeSinceLastChange,
            },
            pump: {
                state: this.pump.state,
                source: this.pump.source,
                timeSinceLastChange: this.pump.timeSinceLastChange,
            },
            heaterActive: this.heater.active,
            doors: doorStates,
            stats: this.getStatsSnapshot(),
            start: this.startTime,
            status: "ok",
        };
    }

    public getTemperature(sensor?: number): TemperatureResponse {
        const readings: TemperatureSensorReading[] = [];
        if (sensor !== undefined) {
            const s = this.temperature.getSensor(sensor);
            if (s) {
                readings.push({ sensor, name: s.name, celsius: s.celsius, timeSinceLastChange: s.timeSinceLastChange });
            }
        } else {
            for (let i = 0; i < this.temperature.sensorCount; i++) {
                const s = this.temperature.getSensor(i);
                if (s) {
                    readings.push({ sensor: i, name: s.name, celsius: s.celsius, timeSinceLastChange: s.timeSinceLastChange });
                }
            }
        }
        return { time: Date.now(), sensors: readings };
    }

    public getFlow(): FlowResponse {
        return {
            time: Date.now(),
            lpm: this.flow.lpm,
            timeSinceLastChange: this.flow.timeSinceLastChange,
        };
    }

    public getPump(): PumpResponse {
        return {
            time: Date.now(),
            state: this.pump.state,
            source: this.pump.source,
            timeSinceLastChange: this.pump.timeSinceLastChange,
        };
    }

    public setPump(state: boolean): PumpResponse {
        this.pumpController.userSetPump(state);
        return this.getPump();
    }

    public getStatsSnapshot(): StatsSnapshot {
        return this.statsAccumulator.getSnapshot();
    }
}

interface NetworkInfo {
    ConnectionType: "Unknown" | "Ethernet" | "Wi-Fi";
    IP: string;
    MAC: string;
    Subnet: string;
    Gateway: string;
    DNS: string;
    SSID?: string;
}

/** Determine which network interface a client is connected through
 *  by matching req.socket.localAddress against OS interface IPs. */
function getClientInterface(localAddress: string | undefined): "Ethernet" | "Wi-Fi" | undefined {
    if (!localAddress) { return undefined; }
    // Strip IPv6-mapped IPv4 prefix (e.g. "::ffff:10.5.137.141" → "10.5.137.141")
    const ip = localAddress.replace(/^::ffff:/, "");
    const ifaces = osNetworkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
        if (!addrs) { continue; }
        for (const addr of addrs) {
            if (addr.address === ip) {
                if (name.startsWith("eth") || name.startsWith("en")) { return "Ethernet"; }
                if (name.startsWith("wlan") || name.startsWith("wl")) { return "Wi-Fi"; }
            }
        }
    }
    return undefined;
}

class NetworkStatus {
    constructor() {
    }

    public async getNetworkDetails(): Promise<NetworkInfo | undefined> {
        const info: NetworkInfo = {
            ConnectionType: "Unknown",
            IP: "",
            MAC: "",
            Subnet: "",
            Gateway: "",
            DNS: ""
        }
        try {

            // Get the default gateway/router separately
            const defaultGateway = await si.networkGatewayDefault();
            // Get network interfaces details
            const networkInterfaces = await si.networkInterfaces();

            // networkInterfaces can return an array or a single object. Ensure it's an array.
            const interfaces = Array.isArray(networkInterfaces) ? networkInterfaces : [networkInterfaces];

            // Classify each interface and pick the best one.
            // Priority: Ethernet > Wi-Fi (non-AP) > Wi-Fi AP > Unknown
            // The AP interface (10.42.0.x) is deprioritized since it's our own hotspot.
            let bestPriority = -1;
            for (const iface of interfaces) {
                if (iface.internal || !iface.ip4) { continue; }

                let connectionType: "Unknown" | "Ethernet" | "Wi-Fi" = "Unknown";
                let priority = 0;
                if (iface.iface.startsWith("eth") || iface.iface.startsWith("en")) {
                    connectionType = "Ethernet";
                    priority = 3;
                } else if (iface.iface.startsWith("wlan") || iface.iface.startsWith("wl")) {
                    connectionType = "Wi-Fi";
                    // AP interface typically uses 10.42.0.x — deprioritize it
                    priority = iface.ip4.startsWith("10.42.0.") ? 1 : 2;
                }

                if (priority > bestPriority) {
                    bestPriority = priority;
                    info.ConnectionType = connectionType;
                    info.IP = iface.ip4;
                    info.MAC = iface.mac;
                    info.Subnet = iface.ip4subnet;
                    info.Gateway = defaultGateway;
                }
            }

            // Always check for active WiFi SSID — even when Ethernet is the
            // primary interface, WiFi may also be connected and the WiFi page
            // needs to know the current SSID.
            if (IS_LINUX) {
                try {
                    const out = execSync("nmcli -t -f active,ssid dev wifi", { timeout: 5000, stdio: "pipe" }).toString();
                    for (const line of out.split("\n")) {
                        if (line.startsWith("yes:")) {
                            const ssid = line.substring(4).trim();
                            if (ssid) { info.SSID = ssid; }
                            break;
                        }
                    }
                } catch { /* fall through to si.wifiConnections */ }
            }
            // Fallback for non-Linux or if nmcli failed
            if (!info.SSID) {
                const wifiConns = await si.wifiConnections();
                if (Array.isArray(wifiConns) && wifiConns.length > 0 && wifiConns[0].ssid) {
                    info.SSID = wifiConns[0].ssid;
                }
            }

            return info;

        } catch (error) {
            logger.logError(LogSeverity.Important, LogArea.Server, error as Error, "network details fetch failed");
            return undefined
        }
    }
}


// ---- Dashboard HTML ----

function formatDuration(ms: number): string {
    const secs = Math.floor(ms / 1000);
    const mins = Math.floor(secs / MINUTE_SECONDS);
    const hrs = Math.floor(mins / MINUTE_SECONDS);
    const days = Math.floor(hrs / 24);
    if (days > 0) {
        return `${days}d ${hrs % 24}h ${mins % MINUTE_SECONDS}m`;
    }
    if (hrs > 0) {
        return `${hrs}h ${mins % 60}m ${secs % MINUTE_SECONDS}s`;
    }
    if (mins > 0) {
        return `${mins}m ${secs % MINUTE_SECONDS}s`;
    }
    return `${secs}s`;
}

/** Format a duration in milliseconds as HH:MM:SS (or Dd HH:MM:SS if over a day). */
function formatDurationHMS(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const h = Math.floor((totalSeconds % 86400) / 3600);
    const m = Math.floor((totalSeconds % 3600) / MINUTE_SECONDS);
    const s = totalSeconds % MINUTE_SECONDS;
    const hms = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    if (days > 0) {
        return `${days}d ${hms}`;
    }
    return hms;
}

function formatMinutes(mins: number): string {
    if (mins < 1) {
        return `${Math.round(mins * MINUTE_SECONDS)}s`;
    }
    if (mins < 60) {
        return `${mins.toFixed(1)}m`;
    }
    const h = Math.floor(mins / MINUTE_SECONDS);
    const m = Math.round(mins % MINUTE_SECONDS);
    return `${h}h ${m}m`;
}

/** Long-form time display with no decimals: "1 hour 2 minutes 30 seconds" / "1時間2分30秒" */
function formatMinutesLong(mins: number): string {
    const totalSeconds = Math.round(mins * MINUTE_SECONDS);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / MINUTE_SECONDS);
    const s = totalSeconds % MINUTE_SECONDS;
    if (h > 0 && m > 0 && s > 0) {
        return L("unitHoursMinutesSeconds", { h: String(h), m: String(m), s: String(s) });
    }
    if (h > 0 && m > 0) {
        return L("unitHoursMinutes", { h: String(h), m: String(m) });
    }
    if (h > 0) {
        return L("unitHours", { n: String(h) });
    }
    if (m > 0 && s > 0) {
        return L("unitMinutesSeconds", { m: String(m), s: String(s) });
    }
    if (m > 0) {
        return L("unitMinutes", { n: String(m) });
    }
    return L("unitSeconds", { n: String(s) });
}

/** Long-form volume: "123.4 liters" / "123.4リットル" */
function formatVolumeLong(liters: number): string {
    if (FLOW_UNITS === "G") {
        return L("unitGallons", { n: litersToGallons(liters).toFixed(1) });
    }
    return L("unitLiters", { n: liters.toFixed(1) });
}

/** Long-form energy: "450 Watt-hours" / "1.23 kilowatt-hours" */
function formatEnergyLong(kwh: number | undefined): string {
    if (kwh === undefined) { return "--"; }
    if (kwh === 0) { return L("unitWh", { n: "0" }); }
    if (kwh < 1) { return L("unitWh", { n: String(Math.round(kwh * 1000)) }); }
    return L("unitKwh", { n: kwh.toFixed(2) });
}

/** Format minutes as H:MM:SS, dropping leading zero on hours. */
function formatTimeHMS(mins: number): string {
    const totalSeconds = Math.round(mins * MINUTE_SECONDS);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / MINUTE_SECONDS);
    const s = totalSeconds % MINUTE_SECONDS;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
}

/** Format volume as a plain number (no unit suffix). */
function formatVolumeNum(liters: number): string {
    if (FLOW_UNITS === "G") {
        return litersToGallons(liters).toFixed(1);
    }
    return liters.toFixed(1);
}

/** Format energy as Watt-hours with comma thousands separator. */
function formatEnergyWh(kwh: number | undefined): string {
    if (kwh === undefined) { return "--"; }
    const wh = Math.round(kwh * 1000);
    return wh.toLocaleString(LOCALE.langCode);
}

/** Format temperature as a plain number (no unit suffix). */
function formatTempNum(celsius: number | undefined): string {
    if (celsius === undefined || celsius === null) { return "--"; }
    if (TEMP_UNITS === "F") {
        return cToF(celsius).toFixed(1);
    }
    return celsius.toFixed(1);
}

function buildStatsCardHtml(stats: StatsSnapshot): string {
    const volUnit = FLOW_UNITS === "G" ? "gal" : "L";
    const tempUnit = TEMP_UNITS === "F" ? "\u00b0F" : "\u00b0C";
    let rows = "";

    // Flow row
    rows += `<tr><td>${L("totalFlow")}</td><td class="val">${formatVolumeNum(stats.today.flowLiters)}</td>`;
    rows += `<td class="val">${formatVolumeNum(stats.week.flowLiters)}</td>`;
    rows += `<td class="val">${formatVolumeNum(stats.month.flowLiters)}</td>`;
    rows += `<td class="unit">${volUnit}</td></tr>\n`;

    // Pump on-time row
    rows += `<tr><td>${L("pumpOnTime")}</td><td class="val">${formatTimeHMS(stats.today.pumpOnMinutes)}</td>`;
    rows += `<td class="val">${formatTimeHMS(stats.week.pumpOnMinutes)}</td>`;
    rows += `<td class="val">${formatTimeHMS(stats.month.pumpOnMinutes)}</td>`;
    rows += `<td class="unit">h:m:s</td></tr>\n`;

    // Pump energy row
    if (PUMP_WATTS > 0) {
        rows += `<tr><td>${L("pumpEnergy")}</td><td class="val">${formatEnergyWh(stats.today.pumpEnergyKwh)}</td>`;
        rows += `<td class="val">${formatEnergyWh(stats.week.pumpEnergyKwh)}</td>`;
        rows += `<td class="val">${formatEnergyWh(stats.month.pumpEnergyKwh)}</td>`;
        rows += `<td class="unit">Wh</td></tr>\n`;
    }

    // Heater energy row
    if (HEATER_WATTS > 0) {
        rows += `<tr><td>${L("heaterEnergy")}</td><td class="val">${formatEnergyWh(stats.today.heaterEnergyKwh)}</td>`;
        rows += `<td class="val">${formatEnergyWh(stats.week.heaterEnergyKwh)}</td>`;
        rows += `<td class="val">${formatEnergyWh(stats.month.heaterEnergyKwh)}</td>`;
        rows += `<td class="unit">Wh</td></tr>\n`;
    }

    // Energy cost row
    if (ENERGY_COST_RATE > 0 && (PUMP_WATTS > 0 || HEATER_WATTS > 0)) {
        const todayTotal = (stats.today.pumpEnergyKwh ?? 0) + (stats.today.heaterEnergyKwh ?? 0);
        const weekTotal = stats.week.pumpEnergyKwh + stats.week.heaterEnergyKwh;
        const monthTotal = stats.month.pumpEnergyKwh + stats.month.heaterEnergyKwh;
        rows += `<tr><td>${L("calendarEnergyCost")}</td><td class="val">${formatCost(todayTotal)}</td>`;
        rows += `<td class="val">${formatCost(weekTotal)}</td>`;
        rows += `<td class="val">${formatCost(monthTotal)}</td>`;
        rows += `<td class="unit"></td></tr>\n`;
    }

    // Water cost row
    if (WATER_COST_RATE > 0) {
        rows += `<tr><td>${L("calendarWaterCost")}</td><td class="val">${formatWaterCost(stats.today.flowLiters)}</td>`;
        rows += `<td class="val">${formatWaterCost(stats.week.flowLiters)}</td>`;
        rows += `<td class="val">${formatWaterCost(stats.month.flowLiters)}</td>`;
        rows += `<td class="unit"></td></tr>\n`;
    }

    // Temperature rows from today's sensors
    for (const t of stats.today.avgTemps) {
        const weekTemp = stats.week.avgTemps.find((wt) => wt.name === t.name);
        const monthTemp = stats.month.avgTemps.find((mt) => mt.name === t.name);
        rows += `<tr><td>${L("avgPrefix", { name: t.name })}</td>`;
        rows += `<td class="val">${formatTempNum(t.avgCelsius)}</td>`;
        rows += `<td class="val">${weekTemp ? formatTempNum(weekTemp.avgCelsius) : "--"}</td>`;
        rows += `<td class="val">${monthTemp ? formatTempNum(monthTemp.avgCelsius) : "--"}</td>`;
        rows += `<td class="unit">${tempUnit}</td></tr>\n`;
    }

    // Hot avg while pumping
    const todayHot = stats.today.hotAvgWhilePumping !== undefined ? formatTempNum(stats.today.hotAvgWhilePumping) : "--";
    const weekHot = stats.week.hotAvgWhilePumping !== undefined ? formatTempNum(stats.week.hotAvgWhilePumping) : "--";
    const monthHot = stats.month.hotAvgWhilePumping !== undefined ? formatTempNum(stats.month.hotAvgWhilePumping) : "--";
    rows += `<tr><td>${L("hotPumping")}</td><td class="val">${todayHot}</td>`;
    rows += `<td class="val">${weekHot}</td><td class="val">${monthHot}</td>`;
    rows += `<td class="unit">${tempUnit}</td></tr>\n`;

    return `<div id="card-stats" class="card" style="min-width:420px">
    <h2>${L("statistics")}</h2>
    <table>
      <tr><td></td><td class="muted">${L("statsToday")}</td><td class="muted">${L("stats7Days")}</td><td class="muted">${L("stats30Days")}</td><td></td></tr>
      ${rows}
    </table>
  </div>`;
}

function buildThermometerSvg(cx: number, cy: number, celsius: number | undefined, label: string, id: string): string {
    const tubeH = 100;
    const tubeW = 12;
    const bulbR = 12;
    const isFahrenheit = TEMP_UNITS === "F";
    const scaleMin = isFahrenheit ? 40 : 0;
    const scaleMax = isFahrenheit ? 180 : 80;
    const tickStep = isFahrenheit ? 20 : 10;
    const unitLabel = isFahrenheit ? "\u00b0F" : "\u00b0C";

    // Convert celsius to display value, clamp to scale
    const displayVal = celsius !== undefined ? (isFahrenheit ? cToF(celsius) : celsius) : scaleMin;
    const clamped = Math.max(scaleMin, Math.min(scaleMax, displayVal));
    const frac = (clamped - scaleMin) / (scaleMax - scaleMin);
    const fillH = frac * tubeH;
    const tubeTop = cy - tubeH / 2 - bulbR;
    const tubeBot = cy + tubeH / 2 - bulbR;
    const tempText = celsius !== undefined ? formatTempShort(celsius) : "--";

    // Build tick marks for every step along the scale
    let ticks = "";
    for (let v = scaleMin; v <= scaleMax; v += tickStep) {
        const tickFrac = (v - scaleMin) / (scaleMax - scaleMin);
        const y = tubeBot - tickFrac * tubeH;
        ticks += `  <line x1="${cx + tubeW / 2 + 2}" y1="${y}" x2="${cx + tubeW / 2 + 6}" y2="${y}" stroke="#64748b" stroke-width="1"/>\n`;
        ticks += `  <text x="${cx + tubeW / 2 + 8}" y="${y + 3}" font-family="sans-serif" font-size="7" fill="#64748b">${v}${unitLabel}</text>\n`;
    }

    return `
  <!-- thermometer: ${label} -->
  <defs>
    <linearGradient id="${id}-grad" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#ef4444"/>
    </linearGradient>
    <clipPath id="${id}-clip">
      <rect x="${cx - tubeW / 2}" y="${tubeBot - fillH}" width="${tubeW}" height="${fillH + bulbR * 2}"/>
    </clipPath>
  </defs>
  <!-- tube outline -->
  <rect x="${cx - tubeW / 2}" y="${tubeTop}" width="${tubeW}" height="${tubeH}" rx="${tubeW / 2}" fill="#1e293b" stroke="#64748b" stroke-width="1.5"/>
  <!-- bulb outline -->
  <circle cx="${cx}" cy="${tubeBot + bulbR}" r="${bulbR}" fill="#1e293b" stroke="#64748b" stroke-width="1.5"/>
  <!-- filled level -->
  <rect x="${cx - tubeW / 2}" y="${tubeBot - fillH}" width="${tubeW}" height="${fillH}" rx="${tubeW / 2}" fill="url(#${id}-grad)" clip-path="url(#${id}-clip)"/>
  <circle cx="${cx}" cy="${tubeBot + bulbR}" r="${bulbR - 2}" fill="url(#${id}-grad)"/>
  <!-- tick marks -->
${ticks}  <!-- reading -->
  <text x="${cx}" y="${tubeBot + bulbR + bulbR + 14}" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="600" fill="#e2e8f0">${tempText}</text>
  <text x="${cx}" y="${tubeBot + bulbR + bulbR + 26}" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#64748b">${label}</text>`;
}

function buildDiagramSvg(lpm: number, pumpOn: boolean, temps: { name: string; celsius: number }[], heaterActive: boolean): string {
    const flowActive = lpm > 0;
    const flowText = flowActive ? formatFlow(lpm) : L("noFlow");
    const flowTextColor = flowActive ? "#38bdf8" : "#64748b";
    const pumpStroke = pumpOn ? "#4ade80" : "#64748b";
    const propellerClass = pumpOn ? ' class="prop-spin"' : "";
    const inletDash = flowActive ? ' class="flow-dash"' : "";

    const coldSensor = findReadingByRole(temps, "Cold");
    const hotSensor = findReadingByRole(temps, "Hot");
    const hotC = hotSensor?.celsius;
    const loopColor = (hotC !== undefined && hotC > 40) ? "#ef4444" : "#38bdf8";
    const loopDash = (flowActive || pumpOn) ? ' class="flow-dash"' : "";
    const faucetDash = flowActive ? ' class="flow-dash"' : "";
    const faucetWaterColor = flowActive ? loopColor : "#475569";
    const heaterStroke = heaterActive ? "#ef4444" : "#38bdf8";
    const heaterFill = heaterActive ? "#7f1d1d" : "#1e3a5f";
    const heaterFlame = heaterActive ? 0.9 : 0;

    return `<svg viewBox="0 0 640 260" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;">
  <!-- inlet pipe: vertical drop then curve right -->
  <path d="M 120 0 L 120 60 Q 120 80 140 80 L 160 80" stroke="#475569" stroke-width="8" fill="none" stroke-linecap="round"/>
  <path d="M 120 0 L 120 60 Q 120 80 140 80 L 160 80" stroke="#38bdf8" stroke-width="4" fill="none" stroke-linecap="round" stroke-dasharray="12 8"${inletDash}/>

  <!-- flow meter box -->
  <rect x="160" y="55" width="100" height="50" rx="8" fill="#334155" stroke="#64748b" stroke-width="2"/>
  <text x="210" y="83" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="600" fill="${flowTextColor}">${flowText}</text>
  <text x="210" y="47" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#64748b">${L("flowMeter")}</text>

  <!-- connecting pipe: flow meter to pump -->
  <path d="M 260 80 L 330 80" stroke="#475569" stroke-width="8" fill="none" stroke-linecap="round"/>
  <path d="M 260 80 L 330 80" stroke="#38bdf8" stroke-width="4" fill="none" stroke-dasharray="12 8"${inletDash}/>

  <!-- pump circle (smaller to fit faucet) -->
  <circle cx="370" cy="80" r="32" fill="#334155" stroke="${pumpStroke}" stroke-width="2.5"/>
  <text x="370" y="122" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#64748b">${L("pump")}</text>

  <!-- propeller (3 blades) -->
  <g transform="translate(370,80)">
    <g${propellerClass}>
      <line x1="0" y1="-22" x2="0" y2="22" stroke="#94a3b8" stroke-width="4" stroke-linecap="round"/>
      <line x1="-19" y1="11" x2="19" y2="-11" stroke="#94a3b8" stroke-width="4" stroke-linecap="round"/>
      <line x1="-19" y1="-11" x2="19" y2="11" stroke="#94a3b8" stroke-width="4" stroke-linecap="round"/>
      <circle cx="0" cy="0" r="4" fill="#64748b"/>
    </g>
  </g>

  <!-- recirculation loop: pump right, down, oval, back to pump bottom -->
  <path d="M 402 80 L 460 80 Q 500 80 500 120 L 500 160 Q 500 200 460 200 L 300 200 Q 260 200 260 160 L 260 140 Q 260 120 280 120 L 330 120 Q 340 120 340 110 L 340 100"
        stroke="#475569" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 402 80 L 460 80 Q 500 80 500 120 L 500 160 Q 500 200 460 200 L 300 200 Q 260 200 260 160 L 260 140 Q 260 120 280 120 L 330 120 Q 340 120 340 110 L 340 100"
        stroke="${loopColor}" stroke-width="4" fill="none" stroke-dasharray="12 8" stroke-linecap="round" stroke-linejoin="round"${loopDash}/>

  <!-- tankless water heater on bottom loop section -->
  <rect x="350" y="178" width="60" height="44" rx="5" fill="${heaterFill}" stroke="${heaterStroke}" stroke-width="2"/>
  <!-- flame icon inside heater -->
  <g transform="translate(380,200)" opacity="${heaterFlame}">
    <path d="M 0 -8 Q 5 -3 3 3 Q 1 7 0 8 Q -1 7 -3 3 Q -5 -3 0 -8 Z" fill="#f97316" opacity="0.9"/>
    <path d="M 0 -4 Q 3 -1 1.5 2 Q 0.5 4 0 5 Q -0.5 4 -1.5 2 Q -3 -1 0 -4 Z" fill="#fbbf24"/>
  </g>
  <text x="380" y="234" text-anchor="middle" font-family="sans-serif" font-size="9" fill="${heaterStroke}">${L("waterHeater")}</text>

  <!-- faucet pipe: branches up from loop horizontal section -->
  <path d="M 460 80 L 460 30 Q 460 16 474 16 L 500 16" stroke="#475569" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 460 80 L 460 30 Q 460 16 474 16 L 500 16" stroke="${faucetWaterColor}" stroke-width="4" fill="none" stroke-dasharray="12 8" stroke-linecap="round" stroke-linejoin="round"${faucetDash}/>

  <!-- showerhead: neck curves from pipe into flared head -->
  <path d="M 500 16 Q 510 16 510 26 L 510 32" stroke="#94a3b8" stroke-width="5" fill="none" stroke-linecap="round"/>
  <!-- flared showerhead face -->
  <path d="M 496 32 L 524 32 L 528 38 L 492 38 Z" fill="#64748b" stroke="#94a3b8" stroke-width="1.5" stroke-linejoin="round"/>
  <!-- showerhead holes -->
  <circle cx="498" cy="36" r="1" fill="#334155"/>
  <circle cx="504" cy="36" r="1" fill="#334155"/>
  <circle cx="510" cy="36" r="1" fill="#334155"/>
  <circle cx="516" cy="36" r="1" fill="#334155"/>
  <circle cx="522" cy="36" r="1" fill="#334155"/>

  <!-- tap valve on vertical pipe section -->
  <g transform="translate(460,50)">
    <line x1="-14" y1="0" x2="14" y2="0" stroke="#94a3b8" stroke-width="4" stroke-linecap="round"
          transform="rotate(${flowActive ? 90 : 0})" style="transition: transform 0.3s ease"/>
    <circle cx="0" cy="0" r="3.5" fill="#64748b"/>
  </g>${flowActive ? `

  <!-- water drops falling from showerhead -->
  <line x1="494" y1="40" x2="494" y2="52" stroke="${loopColor}" stroke-width="1.5" opacity="0.6" class="drip1"/>
  <line x1="500" y1="40" x2="500" y2="54" stroke="${loopColor}" stroke-width="1.5" opacity="0.7" class="drip2"/>
  <line x1="506" y1="40" x2="506" y2="52" stroke="${loopColor}" stroke-width="1.5" opacity="0.6" class="drip3"/>
  <line x1="512" y1="40" x2="512" y2="54" stroke="${loopColor}" stroke-width="1.5" opacity="0.7" class="drip1"/>
  <line x1="518" y1="40" x2="518" y2="52" stroke="${loopColor}" stroke-width="1.5" opacity="0.6" class="drip2"/>
  <line x1="524" y1="40" x2="524" y2="54" stroke="${loopColor}" stroke-width="1.5" opacity="0.7" class="drip3"/>
  <!-- droplets at bottom of streams -->
  <circle cx="494" cy="58" r="1.5" fill="${loopColor}" opacity="0.5" class="drip2"/>
  <circle cx="500" cy="60" r="1.5" fill="${loopColor}" opacity="0.6" class="drip3"/>
  <circle cx="506" cy="58" r="1.5" fill="${loopColor}" opacity="0.5" class="drip1"/>
  <circle cx="512" cy="60" r="1.5" fill="${loopColor}" opacity="0.6" class="drip2"/>
  <circle cx="518" cy="58" r="1.5" fill="${loopColor}" opacity="0.5" class="drip3"/>
  <circle cx="524" cy="60" r="1.5" fill="${loopColor}" opacity="0.6" class="drip1"/>` : ""}

  <!-- arrow on inlet -->
  <polygon points="120,22 114,10 126,10" fill="${flowActive ? "#38bdf8" : "#475569"}"/>

  <!-- temperature gauges -->
${coldSensor ? buildThermometerSvg(60, 100, coldSensor.celsius, L("thermCold"), "therm-cold") : ""}
${buildThermometerSvg(560, 100, hotC, L("thermHot"), "therm-hot")}
</svg>`;
}

function buildLogHtml(): string {
    const lines = logger.fullLog(LogSeverity.Detail);
    const escaped = lines
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    return `<!DOCTYPE html>
<html lang="${LOCALE.langCode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${L("logTitle")}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 20px; color: #94a3b8; }
  .filter-bar { margin-bottom: 12px; display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
  .filter-bar label { color: #94a3b8; font-size: 0.85rem; margin-right: 4px; }
  .filter-bar select { padding: 6px 10px; border-radius: 6px; border: 1px solid #475569;
         background: #1e293b; color: #e2e8f0; font-size: 0.85rem; }
  .log-container { background: #1e293b; border-radius: 10px; padding: 16px; overflow-x: auto; }
  pre { font-family: "SF Mono", "Menlo", "Monaco", "Courier New", monospace;
        font-size: 0.8rem; line-height: 1.5; color: #cbd5e1; white-space: pre-wrap; word-break: break-all; }
  .log-line { }
  .log-line.hidden { display: none; }
  a { color: #94a3b8; }
  .footer { margin-top: 16px; }
</style>
</head>
<body>
<h1>${L("logTitle")}</h1>
<div class="filter-bar">
  <span>
    <label for="severity">${L("logFilter")}</label>
    <select id="severity" onchange="applyFilter()">
      <option value="all">${L("logFilterAll")}</option>
      <option value="info">${L("logFilterInfo")}</option>
      <option value="important">${L("logFilterImportant")}</option>
    </select>
  </span>
  <span>
    <label for="area">${L("logArea")}</label>
    <select id="area" onchange="applyFilter()">
      <option value="all">${L("logFilterAll")}</option>
      <option value="GENERAL">General</option>
      <option value="SERVER">Server</option>
      <option value="SERIAL">Serial</option>
      <option value="TEMP">Temperature</option>
      <option value="FLOW">Flow</option>
      <option value="GPIO">GPIO</option>
    </select>
  </span>
</div>
<div class="log-container">
<pre id="log-pre">${escaped || L("logEmpty")}</pre>
</div>
<p class="footer"><a href="/">${L("logBackToDashboard")}</a></p>
<script>
var logPre = document.getElementById("log-pre");
var rawText = "";
var lastRawLen = 0;

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function filterLines(text) {
  var level = document.getElementById("severity").value;
  var area = document.getElementById("area").value;
  var lines = text.split("\\n");
  return lines.filter(function(line) {
    if (!line.trim()) return false;
    if (level !== "all") {
      var isImportant = /\\[Important\\]|\\[Severe\\]|\\[Priority\\]/.test(line);
      if (level === "important" && !isImportant) return false;
      if (level === "info" && !isImportant && !/\\[Info\\]/.test(line)) return false;
    }
    if (area !== "all") {
      if (line.indexOf("(" + area + ")") === -1) return false;
    }
    return true;
  }).join("\\n");
}

function applyFilter() {
  logPre.innerHTML = escapeHtml(filterLines(rawText)) || "${L("logEmpty")}";
}

function refreshLog() {
  fetch("/api/log").then(function(r) { return r.text(); }).then(function(text) {
    if (text.length !== lastRawLen) {
      lastRawLen = text.length;
      rawText = text;
      applyFilter();
    }
  }).catch(function() {});
}

// Initialize from server-rendered content
rawText = logPre.textContent || "";
lastRawLen = rawText.length;
setInterval(refreshLog, 5000);
</script>
</body>
</html>`;
}

function buildDoorCardHtml(status: StatusResponse): string {
    if (status.doors.length === 0) {
        return `  <div id="card-door" class="card">
    <h2>${L("doors")}</h2>
    <table><tr><td class="muted">${L("doorNoEvents")}</td></tr></table>
  </div>`;
    }
    const rows = status.doors.map(d => {
        if (d.lastOpenTime === 0) {
            return `<tr><td>${d.name}</td><td class="muted">${L("doorNoEvents")}</td></tr>`;
        }
        const timeStr = new Date(d.lastOpenTime).toLocaleTimeString(LOCALE.langCode, { hour: "2-digit", minute: "2-digit" });
        if (d.stillOpen) {
            const openFor = formatDuration(status.time - d.lastOpenTime);
            return `<tr><td>${d.name}</td><td class="val flow-active">${L("doorStillOpen")}</td><td class="muted ago">${timeStr} (${openFor})</td></tr>`;
        }
        const duration = L("doorOpenDuration", { duration: `${d.lastOpenSeconds}s` });
        return `<tr><td>${d.name}</td><td class="val">${timeStr}</td><td class="muted ago">${duration}</td></tr>`;
    }).join("\n");
    return `  <div id="card-door" class="card">
    <h2>${L("doors")}</h2>
    <table>${rows}</table>
  </div>`;
}

/** Build just the cards + uptime bar HTML fragment (used for incremental refresh). */
function buildDashboardCards(status: StatusResponse, stats?: StatsSnapshot, ledMode?: string,
    homekitQrSvg?: string, errorCondition?: LedErrorCondition): string {
    const startDate = new Date(status.start);
    const uptime = formatDuration(status.time - status.start);

    let tempRows = "";
    if (status.temperature.length === 0) {
        tempRows = `<tr><td colspan="3" class="muted">${L("noTempSensors")}</td></tr>`;
    } else {
        status.temperature.forEach((t) => {
            const tempDisplay = formatTemp(t.celsius);
            const agoText = t.timeSinceLastChange >= 0
                ? `<td class="muted ago">${L("ago", { duration: formatDurationHMS(t.timeSinceLastChange) })}</td>`
                : `<td></td>`;
            tempRows += `<tr><td>${t.name}</td><td class="val">${tempDisplay}</td>${agoText}</tr>\n`;
        });
    }

    const flowVal = formatFlow(status.flow.lpm);
    const flowChangedHtml = status.flow.timeSinceLastChange >= 0
        ? `<tr><td class="muted">${L("changedAgo", { duration: formatDuration(status.flow.timeSinceLastChange) })}</td></tr>`
        : "";
    const flowClass = status.flow.lpm > 0 ? "val flow-active" : "val";

    const pumpSource = status.pump.source ? ` (${status.pump.source})` : "";
    const pumpState = status.pump.state ? `${L("pumpOn")}${pumpSource}` : L("pumpOff");
    const pumpChangedHtml = status.pump.timeSinceLastChange >= 0
        ? `<tr><td class="muted">${L("sinceAgo", { duration: formatDuration(status.pump.timeSinceLastChange) })}</td></tr>`
        : "";
    const pumpClass = status.pump.state ? "val pump-on" : "val";

    // LED indicator states — mirrors StatusLEDs GPIO logic
    const ledDot = (on: boolean) => `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${on ? "#ef4444" : "#1e293b"};border:1px solid #475569;vertical-align:middle;margin-right:6px"></span>`;

    const isError = ledMode === "error";
    const isCycling = ledMode === "cycling";
    const ec = errorCondition;

    // Determine per-LED on/flash state based on error condition
    let hotLedOn: boolean;
    let flowLedOn: boolean;
    let pumpLedOn: boolean;
    let hotLedLabel: string;
    let flowLedLabel: string;
    let pumpLedLabel: string;

    const hotTemp = findReadingByRole(status.temperature, "Hot");

    if (isCycling) {
        hotLedOn = true; flowLedOn = true; pumpLedOn = true;
        hotLedLabel = L("ledStartupMode"); flowLedLabel = L("ledStartupMode"); pumpLedLabel = L("ledStartupMode");
    } else if (isError && ec) {
        // Per-condition LED patterns
        switch (ec) {
            case "noTemperature":
                hotLedOn = true; flowLedOn = false; pumpLedOn = false;
                hotLedLabel = L("ledFastBlink"); flowLedLabel = L("ledOff"); pumpLedLabel = L("ledOff");
                break;
            case "noLoopback":
                hotLedOn = false; flowLedOn = true; pumpLedOn = false;
                hotLedLabel = L("ledOff"); flowLedLabel = L("ledFastBlink"); pumpLedLabel = L("ledOff");
                break;
            case "noConnection":
                hotLedOn = true; flowLedOn = false; pumpLedOn = true;
                hotLedLabel = L("ledFastBlink"); flowLedLabel = L("ledOff"); pumpLedLabel = L("ledFastBlink");
                break;
            case "noGateway":
                hotLedOn = true; flowLedOn = false; pumpLedOn = true;
                hotLedLabel = L("ledSlowBlink"); flowLedLabel = L("ledOff"); pumpLedLabel = L("ledSlowBlink");
                break;
            default:
                hotLedOn = true; flowLedOn = true; pumpLedOn = true;
                hotLedLabel = L("ledErrorFlash"); flowLedLabel = L("ledErrorFlash"); pumpLedLabel = L("ledErrorFlash");
                break;
        }
    } else if (isError) {
        // Error mode but no specific condition — flash all
        hotLedOn = true; flowLedOn = true; pumpLedOn = true;
        hotLedLabel = L("ledErrorFlash"); flowLedLabel = L("ledErrorFlash"); pumpLedLabel = L("ledErrorFlash");
    } else {
        // Normal mode
        hotLedOn = hotTemp !== undefined && hotTemp.celsius !== undefined && hotTemp.celsius >= HOT_LED_THRESHOLD;
        flowLedOn = status.flow.lpm > 0;
        pumpLedOn = status.pump.state;
        hotLedLabel = hotLedOn ? L("ledOn") : L("ledOff");
        pumpLedLabel = pumpLedOn ? L("ledOn") : L("ledOff");
        if (status.flow.lpm === 0) {
            flowLedLabel = L("ledOff");
        } else if (status.flow.lpm < 1) {
            flowLedLabel = L("ledSlowBlink");
        } else {
            flowLedLabel = L("ledFastBlink");
        }
    }

    // Error condition label for display above LEDs
    let errorLabel = "";
    if (isError && ec) {
        const errorKey = ec === "noTemperature" ? "errorNoTemperature"
            : ec === "noLoopback" ? "errorNoLoopback"
                : ec === "noConnection" ? "errorNoConnection"
                    : ec === "noGateway" ? "errorNoGateway"
                        : "errorOther";
        errorLabel = L(errorKey);
    }

    return `<div class="cards">
  <div id="card-diagram" class="card diagram-card">
    <h2>${L("systemDiagram")}</h2>
    ${buildDiagramSvg(status.flow.lpm, status.pump.state, status.temperature, status.heaterActive)}
  </div>
  <div id="card-temp" class="card">
    <h2>${L("temperature")}</h2>
    <table>${tempRows}</table>
  </div>
  <div id="card-flow" class="card">
    <h2>${L("flowRate")}</h2>
    <table>
      <tr><td class="${flowClass}">${flowVal}</td></tr>
      ${flowChangedHtml}
    </table>
  </div>
  <div id="card-pump" class="card">
    <h2>${L("pumpHeading")}</h2>
    <table>
      <tr><td class="${pumpClass}">${pumpState}</td></tr>
      ${pumpChangedHtml}
      <tr><td><button class="btn ${status.pump.state ? "btn-on" : "btn-off"}" onclick="togglePump()">${status.pump.state ? L("turnOff") : L("turnOn")}</button></td></tr>
    </table>
  </div>
  <div id="card-leds" class="card">
    <h2>${L("statusLeds")}${isError ? ` <span style="color:#ef4444">${L("ledError")}</span>` : isCycling ? ` <span style="color:#f59e0b">${L("ledStartup")}</span>` : ""}</h2>
${isError && errorLabel ? `    <p style="color:#ef4444;font-weight:600;margin-bottom:10px">${errorLabel}</p>\n` : ""}\
    <table>
      <tr><td>${ledDot(hotLedOn)}${L("ledHot")}</td><td class="muted">${hotLedLabel}</td></tr>
      <tr><td>${ledDot(flowLedOn)}${L("ledFlow")}</td><td class="muted">${flowLedLabel}</td></tr>
      <tr><td>${ledDot(pumpLedOn)}${L("ledPump")}</td><td class="muted">${pumpLedLabel}</td></tr>
    </table>
  </div>
${DOOR_MONITOR_ENABLED ? buildDoorCardHtml(status) : ""}
${stats ? buildStatsCardHtml(stats) : ""}
${homekitQrSvg ? `  <div id="card-homekit" class="card">
    <h2>${L("homekitPairing")}</h2>
    <div style="text-align:center">${homekitQrSvg}</div>
    <p class="muted" style="text-align:center;margin-top:8px">${L("pinLabel", { pin: HOMEKIT_PIN })}</p>
  </div>` : ""}
</div>
<div id="bar-uptime" class="uptime">${L("started")} <span>${startDate.toLocaleString(LOCALE.langCode)}</span> &mdash; ${L("uptime")} <span>${uptime}</span> &mdash; <a href="/calendar" style="color:#94a3b8">${L("calendar")}</a> &mdash; <a href="/settings" style="color:#94a3b8">${L("settings")}</a> &mdash; <a href="/log" style="color:#94a3b8">${L("log")}</a> &mdash; <a href="/wifi" style="color:#94a3b8">${L("wifi")}</a> &mdash; <a href="#" style="color:#94a3b8" onclick="doRestart();return false">${L("restart")}</a></div>`;
}

function buildDashboardHtml(status: StatusResponse, stats?: StatsSnapshot, ledMode?: string,
    homekitQrSvg?: string, homekitUri?: string, networkInfo?: NetworkInfo,
    errorCondition?: LedErrorCondition): string {
    const cardsHtml = buildDashboardCards(status, stats, ledMode, homekitQrSvg, errorCondition);
    return `<!DOCTYPE html>
<html lang="${LOCALE.langCode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${L("pageTitle")}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 20px; color: #94a3b8; }
  .cards { display: flex; flex-wrap: wrap; gap: 16px; }
  .card { background: #1e293b; border-radius: 10px; padding: 20px; min-width: 260px; flex: 1; }
  .card h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em;
             color: #64748b; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 6px 0; }
  .val { font-size: 1.1rem; font-weight: 600; color: #f8fafc; text-align: right; white-space: nowrap; }
  .unit { font-size: 0.75rem; color: #64748b; padding-left: 4px; white-space: nowrap; }
  .ago { padding-left: 12px; }
  .flow-active { color: #38bdf8; }
  .pump-on { color: #4ade80; }
  .muted { color: #64748b; font-size: 0.85rem; }
  .btn { display: inline-block; margin-top: 8px; padding: 8px 20px; border: none;
         border-radius: 6px; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
  .btn-on { background: #4ade80; color: #0f172a; }
  .btn-off { background: #475569; color: #e2e8f0; }
  .uptime { font-size: 0.85rem; color: #64748b; margin-top: 16px; }
  .uptime span { color: #94a3b8; }
  .footer { margin-top: 24px; padding: 16px 0; padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
            border-top: 1px solid #334155; text-align: center; font-size: 0.8rem; color: #475569; }
  .footer a { color: #64748b; text-decoration: none; }
  .footer a:hover { color: #94a3b8; }
  .diagram-card { flex-basis: 100%; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes dash { to { stroke-dashoffset: -40; } }
  @keyframes drip { 0% { opacity: 0.7; transform: translateY(0); } 100% { opacity: 0; transform: translateY(12px); } }
  .prop-spin { animation: spin 1s linear infinite; }
  .flow-dash { animation: dash 0.8s linear infinite; }
  .drip1 { animation: drip 1.2s ease-in infinite; }
  .drip2 { animation: drip 1.2s ease-in 0.4s infinite; }
  .drip3 { animation: drip 1.2s ease-in 0.8s infinite; }
</style>
</head>
<body>
<h1>${L("heading", { version: VERSION })}</h1>
${cardsHtml}
<div class="footer"><a href="https://github.com/markhkrueger/oyu-public">github.com/markhkrueger/oyu-public</a></div>
<script>
function togglePump() {
  var btn = document.querySelector("#card-pump .btn");
  var isOn = btn && btn.classList.contains("btn-on");
  fetch("/pump", {
    method: "PUT",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({state: !isOn})
  }).then(function() { refreshCards(); });
}
function doRestart() {
  if (!confirm(${JSON.stringify(L("restartConfirm"))})) return;
  stopRefresh();
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-size:1.2rem;color:#94a3b8">${L("restartMessage")}</div>';
  fetch("/restart", { method: "POST" }).finally(function() {
    setTimeout(function poll() {
      fetch("/").then(function() { location.href = "/"; }).catch(function() { setTimeout(poll, 2000); });
    }, 3000);
  });
}
var refreshTimer;
function refreshCards() {
  fetch("/api/cards").then(function(r) { return r.text(); }).then(function(html) {
    var tmp = document.createElement("div");
    tmp.innerHTML = html;
    var ids = ["card-diagram","card-temp","card-flow","card-pump","card-leds","card-door","card-stats","card-homekit","bar-uptime"];
    for (var i = 0; i < ids.length; i++) {
      var fresh = tmp.querySelector("#" + ids[i]);
      var existing = document.getElementById(ids[i]);
      if (fresh && existing && existing.innerHTML !== fresh.innerHTML) {
        existing.innerHTML = fresh.innerHTML;
      }
    }
  }).catch(function() {});
}
function stopRefresh() { clearInterval(refreshTimer); }
refreshTimer = setInterval(refreshCards, 5000);
</script>
</body>
</html>`;
}

// ---- Calendar / Day View ----

/** Round up to a "nice" number (1, 2, 3, 5, 10, 20, 30, 50, ...). */
function niceNumber(val: number): number {
    if (val <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(val)));
    const norm = val / pow;
    if (norm <= 1) return pow;
    if (norm <= 2) return 2 * pow;
    if (norm <= 3) return 3 * pow;
    if (norm <= 5) return 5 * pow;
    return 10 * pow;
}

/** Auto-scale: use defaultMax unless actual data is much smaller or exceeds it. */
function niceScale(maxVal: number, defaultMax: number): number {
    if (maxVal <= 0) return defaultMax;
    if (maxVal > defaultMax) return niceNumber(maxVal);
    if (maxVal < defaultMax / 4) return niceNumber(maxVal * 1.5);
    return defaultMax;
}

/** Pick a nice tick step for a given axis range. */
function niceStep(range: number, targetTicks: number = 5): number {
    return niceNumber(range / targetTicks);
}

/** Format seconds for axis labels: 30s, 5m, 1.5h. */
function formatSecondsLabel(secs: number): string {
    if (secs < 120) return `${secs}s`;
    if (secs < 7200) return `${Math.round(secs / MINUTE_SECONDS)}m`;
    return `${(secs / 3600).toFixed(secs % 3600 === 0 ? 0 : 1)}h`;
}

// Fixed scales for weekly/monthly bar comparison
const FIXED_FLOW_MAX = 20;   // liters (or 5 gal)
const FIXED_ENERGY_MAX = 50; // kWh

function buildDayChartSvg(timeline: DayTimeline, nowMinute?: number, summary?: DaySummary): string {
    const W = 960;
    const H = 300;
    const PAD_L = 80;
    const PAD_R = 80;
    const PAD_T = 20;
    const PAD_B = 40;
    const chartW = W - PAD_L - PAD_R;
    const chartH = H - PAD_T - PAD_B;

    const hasTimelineData = timeline.points.some((p) => p !== undefined);
    const showHeater = HEATER_WATTS > 0;
    const showEnergy = PUMP_WATTS > 0 || HEATER_WATTS > 0;
    const lastMin = nowMinute ?? 1440;

    // --- Temperature scale (left axis outer, red) ---
    const tempMin = TEMP_UNITS === "F" ? 50 : 10;
    const tempMax = TEMP_UNITS === "F" ? 176 : 80;
    const tempUnit = TEMP_UNITS === "F" ? "\u00b0F" : "\u00b0C";

    // --- Flow scale (left axis inner, blue, default 0-20 L) ---
    const defaultFlowMax = FLOW_UNITS === "G" ? 5 : 20;
    let actualMaxFlow = 0;
    for (const p of timeline.points) {
        if (p) {
            const val = FLOW_UNITS === "G" ? lpmToGpm(p.flowLpm) : p.flowLpm;
            actualMaxFlow = Math.max(actualMaxFlow, val);
        }
    }
    const flowMax = niceScale(actualMaxFlow, defaultFlowMax);
    const flowUnit = FLOW_UNITS === "G" ? "gal" : "L";

    // --- Compute cumulative pump seconds and energy from timeline ---
    let runPumpSecs = 0;
    let runEnergy = 0;
    const cumulPumpSecs: number[] = new Array(1440).fill(0);
    const cumulEnergyKwh: number[] = new Array(1440).fill(0);
    for (let m = 0; m < 1440; m++) {
        let pumpOn = false;
        for (const iv of timeline.pumpIntervals) {
            const end = iv.endMinute ?? lastMin;
            if (m >= iv.startMinute && m < end) { pumpOn = true; break; }
        }
        if (pumpOn) {
            runPumpSecs += MINUTE_SECONDS;
            runEnergy += PUMP_WATTS * MINUTE_SECONDS / 3600000;
        }
        const pt = timeline.points[m];
        if (pt && pt.heaterActive) {
            runEnergy += HEATER_WATTS * MINUTE_SECONDS / 3600000;
        }
        cumulPumpSecs[m] = runPumpSecs;
        cumulEnergyKwh[m] = runEnergy;
    }

    // --- Pump seconds scale (right axis inner, green) ---
    const pumpSecsMax = niceScale(runPumpSecs, 3600);

    // --- Energy scale (right axis outer, purple, default 0-50 kWh) ---
    const energyMax = niceScale(runEnergy, 50);

    // Scale helper functions
    const xOf = (minute: number): number => PAD_L + (minute / 1440) * chartW;
    const yOfTemp = (c: number): number => {
        const val = TEMP_UNITS === "F" ? cToF(c) : c;
        const frac = (val - tempMin) / (tempMax - tempMin);
        return PAD_T + chartH - frac * chartH;
    };
    const yOfFlow = (lpm: number): number => {
        const val = FLOW_UNITS === "G" ? lpmToGpm(lpm) : lpm;
        const frac = Math.min(val / flowMax, 1);
        return PAD_T + chartH - frac * chartH;
    };
    const yOfPumpSecs = (secs: number): number => {
        const frac = Math.min(secs / pumpSecsMax, 1);
        return PAD_T + chartH - frac * chartH;
    };
    const yOfEnergy = (kwh: number): number => {
        const frac = Math.min(kwh / energyMax, 1);
        return PAD_T + chartH - frac * chartH;
    };

    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;background:#1e293b;border-radius:8px">\n`;

    // --- Grid lines and hour labels ---
    for (let h = 0; h <= 24; h++) {
        const x = xOf(h * 60);
        const isMain = h % 6 === 0;
        svg += `<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${PAD_T + chartH}" stroke="${isMain ? "#475569" : "#334155"}" stroke-width="${isMain ? 1 : 0.5}"/>\n`;
        if (h < 24 && h % 3 === 0) {
            svg += `<text x="${x}" y="${H - 8}" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#64748b">${h.toString().padStart(2, "0")}:00</text>\n`;
        }
    }
    // 15-minute tick marks
    for (let m = 0; m < 1440; m += 15) {
        if (m % 60 !== 0) {
            const x = xOf(m);
            svg += `<line x1="${x}" y1="${PAD_T + chartH}" x2="${x}" y2="${PAD_T + chartH + 3}" stroke="#475569" stroke-width="0.5"/>\n`;
        }
    }

    // --- Left axis outer: temperature labels (red) ---
    const tempStep = TEMP_UNITS === "F" ? 25 : 10;
    for (let t = tempMin; t <= tempMax; t += tempStep) {
        const y = PAD_T + chartH - ((t - tempMin) / (tempMax - tempMin)) * chartH;
        svg += `<line x1="${PAD_L}" y1="${y}" x2="${PAD_L + chartW}" y2="${y}" stroke="#334155" stroke-width="0.5"/>\n`;
        svg += `<text x="${PAD_L / 2 - 2}" y="${y + 3}" text-anchor="end" font-family="sans-serif" font-size="8" fill="#ef4444">${t}${tempUnit}</text>\n`;
    }

    // --- Left axis inner: flow labels (blue) ---
    const flowStepVal = niceStep(flowMax);
    for (let f = 0; f <= flowMax; f += flowStepVal) {
        const y = PAD_T + chartH - (f / flowMax) * chartH;
        const flowLabel = parseFloat(f.toPrecision(10));
        svg += `<text x="${PAD_L - 4}" y="${y + 3}" text-anchor="end" font-family="sans-serif" font-size="8" fill="#38bdf8">${flowLabel}</text>\n`;
    }
    svg += `<text x="${PAD_L - 4}" y="${PAD_T - 4}" text-anchor="end" font-family="sans-serif" font-size="7" fill="#38bdf8">${flowUnit}</text>\n`;

    // --- Right axis inner: pump seconds labels (green) ---
    const pumpStepVal = niceStep(pumpSecsMax);
    for (let s = 0; s <= pumpSecsMax; s += pumpStepVal) {
        const y = yOfPumpSecs(s);
        svg += `<text x="${PAD_L + chartW + 4}" y="${y + 3}" font-family="sans-serif" font-size="8" fill="#4ade80">${formatSecondsLabel(s)}</text>\n`;
    }
    svg += `<text x="${PAD_L + chartW + 4}" y="${PAD_T - 4}" font-family="sans-serif" font-size="7" fill="#4ade80">pump</text>\n`;

    // --- Right axis outer: energy labels (purple) ---
    if (showEnergy) {
        const eStepVal = niceStep(energyMax);
        for (let e = 0; e <= energyMax; e += eStepVal) {
            const y = yOfEnergy(e);
            const eLabel = parseFloat(e.toPrecision(10));
            svg += `<text x="${W - 4}" y="${y + 3}" text-anchor="end" font-family="sans-serif" font-size="8" fill="#a855f7">${eLabel % 1 === 0 ? eLabel : eLabel.toFixed(1)}</text>\n`;
        }
        svg += `<text x="${W - 4}" y="${PAD_T - 4}" text-anchor="end" font-family="sans-serif" font-size="7" fill="#a855f7">kWh</text>\n`;
    }

    // --- Pump intervals (green vertical areas) ---
    const minBarW = chartW / 1440 * 3;
    for (const iv of timeline.pumpIntervals) {
        const end = iv.endMinute ?? nowMinute ?? 1440;
        const x1 = xOf(iv.startMinute);
        const x2 = xOf(end);
        svg += `<rect x="${x1}" y="${PAD_T}" width="${Math.max(x2 - x1, minBarW)}" height="${chartH}" fill="#4ade80" opacity="0.10"/>\n`;
    }

    // --- Activity indicator bars at bottom ---
    const barH = 4;
    const barGap = 1;
    const flowBarY = PAD_T + chartH - barH;
    const pumpBarY = flowBarY - barH - barGap;
    const heaterBarY = pumpBarY - barH - barGap;

    if (hasTimelineData) {
        for (const p of timeline.points) {
            if (p && p.flowLpm > 0) {
                const x = xOf(p.minute);
                const w = Math.max(chartW / 1440, minBarW);
                svg += `<rect x="${x}" y="${flowBarY}" width="${w}" height="${barH}" fill="#38bdf8" opacity="0.6"/>\n`;
            }
        }
        for (const iv of timeline.pumpIntervals) {
            const end = iv.endMinute ?? nowMinute ?? 1440;
            const x1 = xOf(iv.startMinute);
            const x2 = xOf(end);
            svg += `<rect x="${x1}" y="${pumpBarY}" width="${Math.max(x2 - x1, minBarW)}" height="${barH}" fill="#4ade80" opacity="0.6"/>\n`;
        }
        if (showHeater) {
            for (const p of timeline.points) {
                if (p && p.heaterActive) {
                    const x = xOf(p.minute);
                    const w = Math.max(chartW / 1440, minBarW);
                    svg += `<rect x="${x}" y="${heaterBarY}" width="${w}" height="${barH}" fill="#a855f7" opacity="0.6"/>\n`;
                }
            }
        }
    } else if (summary) {
        const centerX = PAD_L + chartW / 2;
        if (summary.flowLiters > 0) {
            svg += `<rect x="${centerX - minBarW / 2}" y="${flowBarY}" width="${minBarW}" height="${barH}" fill="#38bdf8" opacity="0.6"/>\n`;
        }
        if (summary.pumpOnMinutes > 0 || (summary.pumpOnSeconds ?? 0) > 0) {
            const pumpW = Math.max(minBarW, Math.min(chartW, (summary.pumpOnSeconds ?? summary.pumpOnMinutes * MINUTE_SECONDS) / 1440 * chartW));
            svg += `<rect x="${centerX - pumpW / 2}" y="${pumpBarY}" width="${pumpW}" height="${barH}" fill="#4ade80" opacity="0.6"/>\n`;
        }
        if (showHeater && (summary.heaterEnergyKwh ?? 0) > 0) {
            const heaterSecs = summary.heaterOnSeconds ?? (HEATER_WATTS > 0 ? (summary.heaterEnergyKwh! * 3600000 / HEATER_WATTS) : 0);
            const heaterW = Math.max(minBarW, Math.min(chartW, heaterSecs / 1440 * chartW));
            svg += `<rect x="${centerX - heaterW / 2}" y="${heaterBarY}" width="${heaterW}" height="${barH}" fill="#a855f7" opacity="0.6"/>\n`;
        }
    }

    // --- Temperature line (red, smooth curve) ---
    let tempPath = "";
    for (const p of timeline.points) {
        if (p && p.hotCelsius !== undefined) {
            const x = xOf(p.minute);
            const y = yOfTemp(p.hotCelsius);
            tempPath += tempPath ? ` L${x.toFixed(1)},${y.toFixed(1)}` : `M${x.toFixed(1)},${y.toFixed(1)}`;
        }
    }
    if (tempPath) {
        svg += `<path d="${tempPath}" fill="none" stroke="#ef4444" stroke-width="1.5" stroke-linejoin="round"/>\n`;
    }

    // --- Flow line (blue, step function showing L/min per minute) ---
    let flowPath = "";
    let inFlowSeg = false;
    for (let m = 0; m < 1440; m++) {
        const p = timeline.points[m];
        if (p) {
            const y = yOfFlow(p.flowLpm);
            if (!inFlowSeg) {
                flowPath += `M${xOf(m).toFixed(1)},${y.toFixed(1)}`;
                inFlowSeg = true;
            } else {
                flowPath += ` V${y.toFixed(1)}`;
            }
            flowPath += ` H${xOf(m + 1).toFixed(1)}`;
        } else if (inFlowSeg) {
            inFlowSeg = false;
        }
    }
    if (flowPath) {
        svg += `<path d="${flowPath}" fill="none" stroke="#38bdf8" stroke-width="1.5"/>\n`;
    }

    // --- Cumulative pump seconds line (green, dashed step) ---
    if (runPumpSecs > 0) {
        let pumpPath = "";
        let prevPumpY: number | undefined;
        for (let m = 0; m < lastMin; m++) {
            if (cumulPumpSecs[m] > 0 || timeline.points[m]) {
                const x = xOf(m);
                const y = yOfPumpSecs(cumulPumpSecs[m]);
                if (pumpPath === "") {
                    pumpPath = `M${x.toFixed(1)},${y.toFixed(1)}`;
                } else if (y !== prevPumpY) {
                    pumpPath += ` H${x.toFixed(1)} V${y.toFixed(1)}`;
                }
                prevPumpY = y;
            }
        }
        if (pumpPath && prevPumpY !== undefined) {
            pumpPath += ` H${xOf(lastMin).toFixed(1)}`;
        }
        if (pumpPath) {
            svg += `<path d="${pumpPath}" fill="none" stroke="#4ade80" stroke-width="1.5" stroke-dasharray="4 2"/>\n`;
        }
    }

    // --- Cumulative energy line (purple, dashed step) ---
    if (showEnergy && runEnergy > 0) {
        let energyPath = "";
        let prevEnergyY: number | undefined;
        for (let m = 0; m < lastMin; m++) {
            if (cumulEnergyKwh[m] > 0 || timeline.points[m]) {
                const x = xOf(m);
                const y = yOfEnergy(cumulEnergyKwh[m]);
                if (energyPath === "") {
                    energyPath = `M${x.toFixed(1)},${y.toFixed(1)}`;
                } else if (y !== prevEnergyY) {
                    energyPath += ` H${x.toFixed(1)} V${y.toFixed(1)}`;
                }
                prevEnergyY = y;
            }
        }
        if (energyPath && prevEnergyY !== undefined) {
            energyPath += ` H${xOf(lastMin).toFixed(1)}`;
        }
        if (energyPath) {
            svg += `<path d="${energyPath}" fill="none" stroke="#a855f7" stroke-width="1.5" stroke-dasharray="4 2"/>\n`;
        }
    }

    // --- HOT threshold line (dashed red) ---
    const threshY = yOfTemp(HOT_LED_THRESHOLD);
    svg += `<line x1="${PAD_L}" y1="${threshY}" x2="${PAD_L + chartW}" y2="${threshY}" stroke="#ef4444" stroke-width="0.5" stroke-dasharray="4 3" opacity="0.6"/>\n`;

    // --- Chart border ---
    svg += `<rect x="${PAD_L}" y="${PAD_T}" width="${chartW}" height="${chartH}" fill="none" stroke="#475569" stroke-width="1"/>\n`;

    svg += `</svg>`;
    return svg;
}

function buildCalendarDayHtml(timeline: DayTimeline, dateStr: string, isToday: boolean,
    oldestDate: string, latestDate: string, summary?: DaySummary): string {
    const threshDisplay = formatTemp(HOT_LED_THRESHOLD);
    const now = new Date();
    const nowMinute = isToday ? now.getHours() * MINUTE_SECONDS + now.getMinutes() : undefined;

    const hasTimeline = timeline.points.some((p) => p !== undefined);
    const hasData = hasTimeline || summary !== undefined;

    // Use summary values when available (covers restored data after restart), fall back to timeline
    const pumpMins = summary ? summary.pumpOnMinutes : timeline.totalPumpMinutes(nowMinute);
    const flowL = summary ? summary.flowLiters : timeline.totalFlowLiters();
    const hotAboveMins = summary ? (summary.hotAboveThresholdMinutes ?? 0) : timeline.hotAboveThresholdMinutes();

    const chart = hasData ? buildDayChartSvg(timeline, nowMinute, summary) : "";

    // Date navigation
    const d = new Date(dateStr + "T12:00:00");
    const prevDate = new Date(d);
    prevDate.setDate(prevDate.getDate() - 1);
    const nextDate = new Date(d);
    nextDate.setDate(nextDate.getDate() + 1);
    const prevStr = fmtDate(prevDate);
    const nextStr = fmtDate(nextDate);
    const todayStr = fmtDate(new Date());
    const canGoPrev = prevStr >= oldestDate;
    const canGoNext = nextStr <= latestDate;

    return `<!DOCTYPE html>
<html lang="${LOCALE.langCode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${L("calendarTitle")} — ${dateStr}</title>
${isToday ? '<meta http-equiv="refresh" content="60">' : ""}
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background: #0f172a; color: #e2e8f0; padding: 24px; max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 20px; color: #94a3b8; }
  .card { background: #1e293b; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
  .card h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em;
             color: #64748b; margin-bottom: 12px; }
  table { border-collapse: collapse; }
  td { padding: 6px 12px 6px 0; }
  .val { font-size: 1.3rem; font-weight: 600; color: #f8fafc; }
  .muted { color: #64748b; font-size: 0.85rem; }
  .nav { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
  .nav a { color: #94a3b8; text-decoration: none; font-size: 1.1rem; }
  .nav a:hover { color: #e2e8f0; }
  .nav .date { font-size: 1.1rem; font-weight: 600; color: #e2e8f0; min-width: 120px; text-align: center; }
  .legend { display: flex; gap: 20px; margin-top: 8px; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: #94a3b8; }
  .legend-swatch { width: 16px; height: 3px; border-radius: 2px; }
  .view-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .view-tabs a { padding: 6px 16px; border-radius: 6px; font-size: 0.85rem; text-decoration: none;
                 color: #94a3b8; background: #1e293b; }
  .view-tabs a.active { background: #334155; color: #e2e8f0; font-weight: 600; }
  a { color: #94a3b8; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>${L("calendarTitle")}</h1>
<div class="view-tabs">
  <a href="/calendar?date=${dateStr}" class="active">${L("calendarDay")}</a>
  <a href="/calendar?view=week&date=${dateStr}">${L("calendarWeek")}</a>
  <a href="/calendar?view=month&date=${dateStr}">${L("calendarMonth")}</a>
</div>
<div class="nav">
  ${canGoPrev ? `<a href="/calendar?date=${prevStr}">&larr;</a>` : `<span style="color:#334155">&larr;</span>`}
  <span class="date">${dateStr}</span>
  ${canGoNext ? `<a href="/calendar?date=${nextStr}">&rarr;</a>` : `<span style="color:#334155">&rarr;</span>`}
  ${!isToday ? `<a href="/calendar?date=${todayStr}" style="font-size:0.85rem">${L("calendarToday")}</a>` : ""}
</div>
${hasData ? `<div class="card">
  ${chart}
  <div class="legend">
    <span class="legend-item"><span class="legend-swatch" style="background:#ef4444"></span>${L("thermHot")}</span>
    <span class="legend-item"><span class="legend-swatch" style="background:#38bdf8"></span>${L("flowRate")}</span>
    <span class="legend-item"><span class="legend-swatch" style="background:#4ade80;height:10px;opacity:0.4"></span>${L("pumpHeading")}</span>
${(PUMP_WATTS > 0 || HEATER_WATTS > 0) ? `    <span class="legend-item"><span class="legend-swatch" style="background:#a855f7"></span>${L("calendarEnergy")}</span>` : ""}
  </div>
</div>` : ""}
${hasData ? `<div class="card">
  <table>
    <tr><td>${L("calendarPumpRunTime")}</td><td class="val">${formatMinutesLong(pumpMins)}</td></tr>
    <tr><td>${L("calendarTotalFlow")}</td><td class="val">${formatVolumeLong(flowL)}</td></tr>
    <tr><td>${L("calendarHotAboveThreshold", { threshold: threshDisplay })}</td><td class="val">${formatMinutesLong(hotAboveMins)}</td></tr>
    ${(PUMP_WATTS > 0 || HEATER_WATTS > 0) && summary && ((summary.pumpEnergyKwh ?? 0) + (summary.heaterEnergyKwh ?? 0)) > 0 ? `<tr><td>${L("calendarEnergy")}</td><td class="val">${formatEnergyLong((summary.pumpEnergyKwh ?? 0) + (summary.heaterEnergyKwh ?? 0))}</td></tr>` : ""}
    ${PUMP_WATTS > 0 && summary?.pumpEnergyKwh ? `<tr><td style="padding-left:16px">${L("calendarPumpEnergy")}</td><td class="val">${formatEnergyLong(summary.pumpEnergyKwh)}</td></tr>` : ""}
    ${HEATER_WATTS > 0 && summary?.heaterEnergyKwh ? `<tr><td style="padding-left:16px">${L("calendarHeaterEnergy")}</td><td class="val">${formatEnergyLong(summary.heaterEnergyKwh)}</td></tr>` : ""}
    ${ENERGY_COST_RATE > 0 && summary && ((summary.pumpEnergyKwh ?? 0) + (summary.heaterEnergyKwh ?? 0)) > 0 ? `<tr><td>${L("calendarEnergyCost")}</td><td class="val">${formatCost((summary.pumpEnergyKwh ?? 0) + (summary.heaterEnergyKwh ?? 0))}</td></tr>` : ""}
    ${WATER_COST_RATE > 0 && flowL > 0 ? `<tr><td>${L("calendarWaterCost")}</td><td class="val">${formatWaterCost(flowL)}</td></tr>` : ""}
  </table>
</div>
${summary?.avgTemps && summary.avgTemps.length > 0 ? `<div class="card">
  <h2>${L("calendarTemperatures")}</h2>
  <table>
    <tr><td></td><td class="muted">${L("calendarTempAvg")}</td><td class="muted">${L("calendarTempMin")}</td><td class="muted">${L("calendarTempMax")}</td></tr>
    ${summary.avgTemps.map((t) => {
        const range = summary.tempRanges?.find((r) => r.name === t.name);
        return `<tr><td>${t.name}</td><td class="val">${formatTemp(t.avgCelsius)}</td><td class="val">${range ? formatTemp(range.minCelsius) : "--"}</td><td class="val">${range ? formatTemp(range.maxCelsius) : "--"}</td></tr>`;
    }).join("\n    ")}
  </table>
</div>` : ""}` : `<div class="card"><p class="muted">${L("calendarNoData")}</p></div>`}
<p style="margin-top:16px"><a href="/">${L("calendarBackToDashboard")}</a></p>
</body>
</html>`;
}

/** Return the Sunday that starts the week containing the given date string. */
function weekSunday(dateStr: string): Date {
    const d = new Date(dateStr + "T12:00:00");
    const day = d.getDay(); // 0=Sun
    d.setDate(d.getDate() - day);
    return d;
}

function fmtDate(d: Date): string {
    const pad = (n: number): string => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function buildCalendarWeekHtml(
    allDays: DaySummary[],
    todaySummary: DaySummary,
    anchorDate: string,
    oldestDate: string,
    latestDate: string
): string {
    const sunday = weekSunday(anchorDate);
    const dayNames = [L("daySun"), L("dayMon"), L("dayTue"), L("dayWed"), L("dayThu"), L("dayFri"), L("daySat")];
    const monthNames = (L("monthNames")).split(",");
    const todayStr = fmtDate(new Date());

    // Build map of date -> DaySummary from history + today
    const dayMap = new Map<string, DaySummary>();
    for (const d of allDays) { dayMap.set(d.date, d); }
    dayMap.set(todaySummary.date, todaySummary);

    // Collect 7 days starting from Sunday
    const weekDays: { dateStr: string; dayOfMonth: number; dayName: string; summary?: DaySummary; isToday: boolean }[] = [];
    for (let i = 0; i < 7; i++) {
        const dt = new Date(sunday);
        dt.setDate(sunday.getDate() + i);
        const ds = fmtDate(dt);
        weekDays.push({
            dateStr: ds,
            dayOfMonth: dt.getDate(),
            dayName: dayNames[i],
            summary: dayMap.get(ds),
            isToday: ds === todayStr,
        });
    }

    // Find max values for scaling bars (pump/hot use relative, flow/energy use fixed)
    let maxPump = 0, maxHot = 0;
    const showEnergy = PUMP_WATTS > 0 || HEATER_WATTS > 0;
    const fixedFlowMax = FLOW_UNITS === "G" ? litersToGallons(FIXED_FLOW_MAX) : FIXED_FLOW_MAX;
    for (const wd of weekDays) {
        if (wd.summary) {
            maxPump = Math.max(maxPump, wd.summary.pumpOnMinutes);
            maxHot = Math.max(maxHot, wd.summary.hotAboveThresholdMinutes ?? 0);
        }
    }
    if (maxPump === 0) { maxPump = 1; }
    if (maxHot === 0) { maxHot = 1; }

    // Title: month(s) and year
    const firstMonth = new Date(sunday);
    const lastDay = new Date(sunday);
    lastDay.setDate(sunday.getDate() + 6);
    let title: string;
    if (firstMonth.getMonth() === lastDay.getMonth()) {
        title = `${monthNames[firstMonth.getMonth()]} ${firstMonth.getFullYear()}`;
    } else if (firstMonth.getFullYear() === lastDay.getFullYear()) {
        title = `${monthNames[firstMonth.getMonth()]} / ${monthNames[lastDay.getMonth()]} ${firstMonth.getFullYear()}`;
    } else {
        title = `${monthNames[firstMonth.getMonth()]} ${firstMonth.getFullYear()} / ${monthNames[lastDay.getMonth()]} ${lastDay.getFullYear()}`;
    }

    // Navigation dates
    const prevSunday = new Date(sunday);
    prevSunday.setDate(sunday.getDate() - 7);
    const nextSunday = new Date(sunday);
    nextSunday.setDate(sunday.getDate() + 7);
    // The Saturday that ends the previous week
    const prevSat = new Date(sunday);
    prevSat.setDate(sunday.getDate() - 1);
    const canGoPrev = fmtDate(prevSat) >= oldestDate;
    // The Sunday that starts the next week
    const canGoNext = fmtDate(nextSunday) <= latestDate;

    const threshDisplay = formatTemp(HOT_LED_THRESHOLD);

    // Weekly totals
    let totalPump = 0, totalFlow = 0, totalHot = 0;
    let totalPumpEnergy = 0, totalHeaterEnergy = 0;
    for (const wd of weekDays) {
        if (wd.summary) {
            totalPump += wd.summary.pumpOnMinutes;
            totalFlow += wd.summary.flowLiters;
            totalHot += wd.summary.hotAboveThresholdMinutes ?? 0;
            totalPumpEnergy += wd.summary.pumpEnergyKwh ?? 0;
            totalHeaterEnergy += wd.summary.heaterEnergyKwh ?? 0;
        }
    }

    // Build day cards
    let dayCards = "";
    for (const wd of weekDays) {
        const s = wd.summary;
        const pumpH = s ? Math.round((s.pumpOnMinutes / maxPump) * 80) : 0;
        const flowVal_l = s ? (FLOW_UNITS === "G" ? litersToGallons(s.flowLiters) : s.flowLiters) : 0;
        const flowH = s ? Math.round(Math.min(flowVal_l / fixedFlowMax, 1) * 80) : 0;
        const hotH = s ? Math.round(((s.hotAboveThresholdMinutes ?? 0) / maxHot) * 80) : 0;
        const dayEnergy = s && showEnergy ? (s.pumpEnergyKwh ?? 0) + (s.heaterEnergyKwh ?? 0) : 0;
        const energyH = showEnergy && s ? Math.round(Math.min(dayEnergy / FIXED_ENERGY_MAX, 1) * 80) : 0;
        const border = wd.isToday ? "border:2px solid #3b82f6" : "border:1px solid #334155";
        const pumpVal = s ? formatMinutes(s.pumpOnMinutes) : "--";
        const flowVal = s ? formatVolume(s.flowLiters) : "--";
        const hotVal = s && s.hotAboveThresholdMinutes !== undefined ? formatMinutes(s.hotAboveThresholdMinutes) : "--";
        const energyVal = showEnergy && s ? formatEnergy(dayEnergy) : "";

        dayCards += `
    <a href="/calendar?date=${wd.dateStr}" style="text-decoration:none;color:inherit;flex:1;min-width:0">
    <div class="day-card" style="${border}">
      <div class="day-label">${wd.dayName}</div>
      <div class="day-num">${wd.dayOfMonth}</div>
      <div class="bars">
        <div class="bar-col">
          <div class="bar" style="height:${pumpH}px;background:#4ade80" title="${L("calendarPumpRunTime")}"></div>
        </div>
        <div class="bar-col">
          <div class="bar" style="height:${flowH}px;background:#38bdf8" title="${L("calendarTotalFlow")}"></div>
        </div>
        <div class="bar-col">
          <div class="bar" style="height:${hotH}px;background:#ef4444" title="${L("calendarHotAboveThreshold", { threshold: threshDisplay })}"></div>
        </div>
${showEnergy ? `        <div class="bar-col">
          <div class="bar" style="height:${energyH}px;background:#a855f7" title="${L("calendarEnergy")}"></div>
        </div>` : ""}
      </div>
      <div class="day-vals">
        <span style="color:#4ade80">${pumpVal}</span>
        <span style="color:#38bdf8">${flowVal}</span>
        <span style="color:#ef4444">${hotVal}</span>
${showEnergy ? `        <span style="color:#a855f7">${energyVal}</span>` : ""}
      </div>
    </div>
    </a>`;
    }

    return `<!DOCTYPE html>
<html lang="${LOCALE.langCode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${L("calendarWeekTitle")}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background: #0f172a; color: #e2e8f0; padding: 24px; max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 4px; color: #94a3b8; }
  .subtitle { font-size: 0.9rem; color: #64748b; margin-bottom: 16px; }
  .nav { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
  .nav a, .nav button { color: #94a3b8; text-decoration: none; font-size: 1.1rem; background: none; border: none; cursor: pointer; }
  .nav a:hover, .nav button:hover { color: #e2e8f0; }
  .nav .title { font-size: 1.1rem; font-weight: 600; color: #e2e8f0; min-width: 200px; text-align: center; }
  .view-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .view-tabs a { padding: 6px 16px; border-radius: 6px; font-size: 0.85rem; text-decoration: none;
                 color: #94a3b8; background: #1e293b; }
  .view-tabs a.active { background: #334155; color: #e2e8f0; font-weight: 600; }
  .week-grid { display: flex; gap: 8px; }
  .day-card { background: #1e293b; border-radius: 8px; padding: 10px 8px 8px; text-align: center; }
  .day-label { font-size: 0.7rem; text-transform: uppercase; color: #64748b; letter-spacing: 0.05em; }
  .day-num { font-size: 1.1rem; font-weight: 600; color: #e2e8f0; margin: 2px 0 8px; }
  .bars { display: flex; justify-content: center; gap: 4px; height: 84px; align-items: flex-end; }
  .bar-col { display: flex; flex-direction: column; justify-content: flex-end; }
  .bar { width: 12px; border-radius: 3px 3px 0 0; min-height: 2px; }
  .day-vals { display: flex; flex-direction: column; gap: 1px; margin-top: 6px; font-size: 0.65rem; font-weight: 600; }
  .legend { display: flex; gap: 20px; margin: 16px 0; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: #94a3b8; }
  .legend-swatch { width: 12px; height: 12px; border-radius: 3px; }
  .date-form { display: flex; align-items: center; gap: 8px; }
  .date-form input { padding: 4px 8px; border-radius: 4px; border: 1px solid #475569;
                     background: #0f172a; color: #e2e8f0; font-size: 0.85rem; }
  .date-form button { padding: 4px 12px; border-radius: 4px; border: none;
                      background: #334155; color: #e2e8f0; font-size: 0.85rem; cursor: pointer; }
  .totals { background: #1e293b; border-radius: 10px; padding: 16px 20px; margin-bottom: 16px; }
  .totals h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em;
               color: #64748b; margin-bottom: 10px; }
  .totals table { border-collapse: collapse; }
  .totals td { padding: 4px 12px 4px 0; }
  .totals .val { font-size: 1.2rem; font-weight: 600; color: #f8fafc; }
  a.footer-link { color: #94a3b8; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>${L("calendarWeekTitle")}</h1>
<div class="view-tabs">
  <a href="/calendar?date=${anchorDate}">${L("calendarDay")}</a>
  <a href="/calendar?view=week&date=${anchorDate}" class="active">${L("calendarWeek")}</a>
  <a href="/calendar?view=month&date=${anchorDate}">${L("calendarMonth")}</a>
</div>
<div class="nav">
  ${canGoPrev ? `<a href="/calendar?view=week&date=${fmtDate(prevSunday)}">&larr;</a>` : `<span style="color:#334155">&larr;</span>`}
  <span class="title">${title}</span>
  ${canGoNext ? `<a href="/calendar?view=week&date=${fmtDate(nextSunday)}">&rarr;</a>` : `<span style="color:#334155">&rarr;</span>`}
</div>
<div class="week-grid">
${dayCards}
</div>
<div class="legend">
  <span class="legend-item"><span class="legend-swatch" style="background:#4ade80"></span>${L("calendarPumpRunTime")}</span>
  <span class="legend-item"><span class="legend-swatch" style="background:#38bdf8"></span>${L("calendarTotalFlow")}</span>
  <span class="legend-item"><span class="legend-swatch" style="background:#ef4444"></span>${L("calendarHotAboveThreshold", { threshold: threshDisplay })}</span>
${showEnergy ? `  <span class="legend-item"><span class="legend-swatch" style="background:#a855f7"></span>${L("calendarEnergy")}</span>` : ""}
</div>
<div class="totals">
  <h2>${L("calendarWeekTotal")}</h2>
  <table>
    <tr><td>${L("calendarPumpRunTime")}</td><td class="val">${formatMinutesLong(totalPump)}</td></tr>
    <tr><td>${L("calendarTotalFlow")}</td><td class="val">${formatVolumeLong(totalFlow)}</td></tr>
    <tr><td>${L("calendarHotAboveThreshold", { threshold: threshDisplay })}</td><td class="val">${formatMinutesLong(totalHot)}</td></tr>
    ${showEnergy && (totalPumpEnergy + totalHeaterEnergy) > 0 ? `<tr><td>${L("calendarEnergy")}</td><td class="val">${formatEnergyLong(totalPumpEnergy + totalHeaterEnergy)}</td></tr>` : ""}
    ${PUMP_WATTS > 0 && totalPumpEnergy > 0 ? `<tr><td style="padding-left:16px">${L("calendarPumpEnergy")}</td><td class="val">${formatEnergyLong(totalPumpEnergy)}</td></tr>` : ""}
    ${HEATER_WATTS > 0 && totalHeaterEnergy > 0 ? `<tr><td style="padding-left:16px">${L("calendarHeaterEnergy")}</td><td class="val">${formatEnergyLong(totalHeaterEnergy)}</td></tr>` : ""}
    ${ENERGY_COST_RATE > 0 && (totalPumpEnergy + totalHeaterEnergy) > 0 ? `<tr><td>${L("calendarEnergyCost")}</td><td class="val">${formatCost(totalPumpEnergy + totalHeaterEnergy)}</td></tr>` : ""}
    ${ENERGY_COST_RATE > 0 && totalPumpEnergy > 0 && totalHeaterEnergy > 0 ? `<tr><td style="padding-left:16px">${L("calendarPumpEnergyCost")}</td><td class="val">${formatCost(totalPumpEnergy)}</td></tr>` : ""}
    ${ENERGY_COST_RATE > 0 && totalPumpEnergy > 0 && totalHeaterEnergy > 0 ? `<tr><td style="padding-left:16px">${L("calendarHeaterEnergyCost")}</td><td class="val">${formatCost(totalHeaterEnergy)}</td></tr>` : ""}
    ${WATER_COST_RATE > 0 && totalFlow > 0 ? `<tr><td>${L("calendarWaterCost")}</td><td class="val">${formatWaterCost(totalFlow)}</td></tr>` : ""}
  </table>
</div>
<form class="date-form" onsubmit="location.href='/calendar?view=week&date='+this.d.value;return false">
  <label style="font-size:0.8rem;color:#64748b">${L("calendarDate")}:</label>
  <input type="date" name="d" value="${anchorDate}" min="${oldestDate}" max="${latestDate}">
  <button type="submit">${L("calendarGo")}</button>
</form>
<p style="margin-top:16px"><a class="footer-link" href="/">${L("calendarBackToDashboard")}</a></p>
</body>
</html>`;
}

function buildCalendarMonthHtml(
    allDays: DaySummary[],
    todaySummary: DaySummary,
    anchorDate: string,
    oldestDate: string,
    latestDate: string
): string {
    const monthNames = (L("monthNames")).split(",");
    const dayNames = [L("daySun"), L("dayMon"), L("dayTue"), L("dayWed"), L("dayThu"), L("dayFri"), L("daySat")];
    const todayStr = fmtDate(new Date());

    // Determine the month from the anchor date
    const anchor = new Date(anchorDate + "T12:00:00");
    const year = anchor.getFullYear();
    const month = anchor.getMonth();
    const title = `${monthNames[month]} ${year}`;

    // First and last day of this month
    const firstOfMonth = new Date(year, month, 1);
    const lastOfMonth = new Date(year, month + 1, 0);
    const daysInMonth = lastOfMonth.getDate();
    const startDow = firstOfMonth.getDay(); // 0=Sun

    // Build map of date -> DaySummary
    const dayMap = new Map<string, DaySummary>();
    for (const d of allDays) { dayMap.set(d.date, d); }
    dayMap.set(todaySummary.date, todaySummary);

    // Build calendar grid cells: leading blanks + days + trailing blanks
    interface CalCell {
        day?: number;
        dateStr?: string;
        summary?: DaySummary;
        isToday: boolean;
        inMonth: boolean;
    }
    const cells: CalCell[] = [];
    // Leading blank cells
    for (let i = 0; i < startDow; i++) {
        cells.push({ isToday: false, inMonth: false });
    }
    // Day cells
    for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(year, month, d);
        const ds = fmtDate(dt);
        cells.push({ day: d, dateStr: ds, summary: dayMap.get(ds), isToday: ds === todayStr, inMonth: true });
    }
    // Trailing blank cells to fill the last row
    while (cells.length % 7 !== 0) {
        cells.push({ isToday: false, inMonth: false });
    }

    // Find max values for scaling bars across the month (pump/hot relative, flow/energy fixed)
    let maxPump = 0, maxHot = 0;
    const showEnergy = PUMP_WATTS > 0 || HEATER_WATTS > 0;
    const fixedFlowMax = FLOW_UNITS === "G" ? litersToGallons(FIXED_FLOW_MAX) : FIXED_FLOW_MAX;
    for (const c of cells) {
        if (c.summary) {
            maxPump = Math.max(maxPump, c.summary.pumpOnMinutes);
            maxHot = Math.max(maxHot, c.summary.hotAboveThresholdMinutes ?? 0);
        }
    }
    if (maxPump === 0) { maxPump = 1; }
    if (maxHot === 0) { maxHot = 1; }

    const threshDisplay = formatTemp(HOT_LED_THRESHOLD);

    // Monthly totals
    let totalPump = 0, totalFlow = 0, totalHot = 0;
    let totalPumpEnergy = 0, totalHeaterEnergy = 0;
    for (const c of cells) {
        if (c.summary && c.inMonth) {
            totalPump += c.summary.pumpOnMinutes;
            totalFlow += c.summary.flowLiters;
            totalHot += c.summary.hotAboveThresholdMinutes ?? 0;
            totalPumpEnergy += c.summary.pumpEnergyKwh ?? 0;
            totalHeaterEnergy += c.summary.heaterEnergyKwh ?? 0;
        }
    }

    // Build grid HTML
    let gridHtml = "<tr>";
    for (let i = 0; i < 7; i++) {
        gridHtml += `<th>${dayNames[i]}</th>`;
    }
    gridHtml += "</tr>\n";
    for (let i = 0; i < cells.length; i++) {
        if (i % 7 === 0) { gridHtml += "<tr>"; }
        const c = cells[i];
        if (!c.inMonth) {
            gridHtml += `<td class="cell empty"></td>`;
        } else {
            const s = c.summary;
            const barH = 50;
            const pumpH = s ? Math.round((s.pumpOnMinutes / maxPump) * barH) : 0;
            const flowVal_l = s ? (FLOW_UNITS === "G" ? litersToGallons(s.flowLiters) : s.flowLiters) : 0;
            const flowH = s ? Math.round(Math.min(flowVal_l / fixedFlowMax, 1) * barH) : 0;
            const hotH = s ? Math.round(((s.hotAboveThresholdMinutes ?? 0) / maxHot) * barH) : 0;
            const cellEnergy = s && showEnergy ? (s.pumpEnergyKwh ?? 0) + (s.heaterEnergyKwh ?? 0) : 0;
            const energyH = showEnergy && s ? Math.round(Math.min(cellEnergy / FIXED_ENERGY_MAX, 1) * barH) : 0;
            const border = c.isToday ? "border-color:#3b82f6" : "";
            const pumpVal = s ? formatMinutes(s.pumpOnMinutes) : "--";
            const flowVal = s ? formatVolume(s.flowLiters) : "--";
            const hotVal = s && s.hotAboveThresholdMinutes !== undefined ? formatMinutes(s.hotAboveThresholdMinutes) : "--";
            const energyVal = showEnergy && s ? formatEnergy(cellEnergy) : "";
            gridHtml += `<td class="cell" style="${border}">
        <a href="/calendar?date=${c.dateStr}" class="cell-link">
          <div class="cell-day">${c.day}</div>
          <div class="cell-bars">
            <div class="bar" style="height:${pumpH}px;background:#4ade80"></div>
            <div class="bar" style="height:${flowH}px;background:#38bdf8"></div>
            <div class="bar" style="height:${hotH}px;background:#ef4444"></div>
${showEnergy ? `            <div class="bar" style="height:${energyH}px;background:#a855f7"></div>` : ""}
          </div>
          <div class="cell-vals">
            <span style="color:#4ade80">${pumpVal}</span>
            <span style="color:#38bdf8">${flowVal}</span>
            <span style="color:#ef4444">${hotVal}</span>
${showEnergy ? `            <span style="color:#a855f7">${energyVal}</span>` : ""}
          </div>
        </a>
      </td>`;
        }
        if (i % 7 === 6) { gridHtml += "</tr>\n"; }
    }

    // Navigation
    const prevMonth = new Date(year, month - 1, 1);
    const nextMonth = new Date(year, month + 1, 1);
    const prevLastDay = new Date(year, month, 0); // last day of prev month
    const canGoPrev = fmtDate(prevLastDay) >= oldestDate;
    const canGoNext = fmtDate(nextMonth) <= latestDate;

    return `<!DOCTYPE html>
<html lang="${LOCALE.langCode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${L("calendarMonthTitle")} — ${title}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background: #0f172a; color: #e2e8f0; padding: 24px; max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 4px; color: #94a3b8; }
  .nav { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
  .nav a { color: #94a3b8; text-decoration: none; font-size: 1.1rem; }
  .nav a:hover { color: #e2e8f0; }
  .nav .title { font-size: 1.1rem; font-weight: 600; color: #e2e8f0; min-width: 200px; text-align: center; }
  .view-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .view-tabs a { padding: 6px 16px; border-radius: 6px; font-size: 0.85rem; text-decoration: none;
                 color: #94a3b8; background: #1e293b; }
  .view-tabs a.active { background: #334155; color: #e2e8f0; font-weight: 600; }
  table.month { width: 100%; border-collapse: separate; border-spacing: 4px; }
  table.month th { font-size: 0.7rem; text-transform: uppercase; color: #64748b; padding: 4px 0;
                   letter-spacing: 0.05em; text-align: center; }
  .cell { background: #1e293b; border-radius: 6px; border: 1px solid #334155; vertical-align: top;
          padding: 0; height: 120px; }
  .cell.empty { background: transparent; border: none; }
  .cell-link { display: block; padding: 6px; text-decoration: none; color: inherit; height: 100%; }
  .cell-day { font-size: 0.85rem; font-weight: 600; color: #e2e8f0; margin-bottom: 4px; }
  .cell-bars { display: flex; justify-content: center; gap: 3px; height: 54px; align-items: flex-end; }
  .bar { width: 10px; border-radius: 2px 2px 0 0; min-height: 1px; }
  .cell-vals { display: flex; flex-direction: column; gap: 0; margin-top: 3px; font-size: 0.55rem; font-weight: 600; line-height: 1.2; }
  .legend { display: flex; gap: 20px; margin: 12px 0; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: #94a3b8; }
  .legend-swatch { width: 12px; height: 12px; border-radius: 3px; }
  .totals { background: #1e293b; border-radius: 10px; padding: 16px 20px; margin-bottom: 16px; }
  .totals h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em;
               color: #64748b; margin-bottom: 10px; }
  .totals table { border-collapse: collapse; }
  .totals td { padding: 4px 12px 4px 0; }
  .totals .val { font-size: 1.2rem; font-weight: 600; color: #f8fafc; }
  .date-form { display: flex; align-items: center; gap: 8px; }
  .date-form input { padding: 4px 8px; border-radius: 4px; border: 1px solid #475569;
                     background: #0f172a; color: #e2e8f0; font-size: 0.85rem; }
  .date-form button { padding: 4px 12px; border-radius: 4px; border: none;
                      background: #334155; color: #e2e8f0; font-size: 0.85rem; cursor: pointer; }
  a.footer-link { color: #94a3b8; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>${L("calendarMonthTitle")}</h1>
<div class="view-tabs">
  <a href="/calendar?date=${anchorDate}">${L("calendarDay")}</a>
  <a href="/calendar?view=week&date=${anchorDate}">${L("calendarWeek")}</a>
  <a href="/calendar?view=month&date=${anchorDate}" class="active">${L("calendarMonth")}</a>
</div>
<div class="nav">
  ${canGoPrev ? `<a href="/calendar?view=month&date=${fmtDate(prevMonth)}">&larr;</a>` : `<span style="color:#334155">&larr;</span>`}
  <span class="title">${title}</span>
  ${canGoNext ? `<a href="/calendar?view=month&date=${fmtDate(nextMonth)}">&rarr;</a>` : `<span style="color:#334155">&rarr;</span>`}
</div>
<table class="month">
${gridHtml}
</table>
<div class="legend">
  <span class="legend-item"><span class="legend-swatch" style="background:#4ade80"></span>${L("calendarPumpRunTime")}</span>
  <span class="legend-item"><span class="legend-swatch" style="background:#38bdf8"></span>${L("calendarTotalFlow")}</span>
  <span class="legend-item"><span class="legend-swatch" style="background:#ef4444"></span>${L("calendarHotAboveThreshold", { threshold: threshDisplay })}</span>
${showEnergy ? `  <span class="legend-item"><span class="legend-swatch" style="background:#a855f7"></span>${L("calendarEnergy")}</span>` : ""}
</div>
<div class="totals">
  <h2>${L("calendarMonthTotal")}</h2>
  <table>
    <tr><td>${L("calendarPumpRunTime")}</td><td class="val">${formatMinutesLong(totalPump)}</td></tr>
    <tr><td>${L("calendarTotalFlow")}</td><td class="val">${formatVolumeLong(totalFlow)}</td></tr>
    <tr><td>${L("calendarHotAboveThreshold", { threshold: threshDisplay })}</td><td class="val">${formatMinutesLong(totalHot)}</td></tr>
    ${showEnergy && (totalPumpEnergy + totalHeaterEnergy) > 0 ? `<tr><td>${L("calendarEnergy")}</td><td class="val">${formatEnergyLong(totalPumpEnergy + totalHeaterEnergy)}</td></tr>` : ""}
    ${PUMP_WATTS > 0 && totalPumpEnergy > 0 ? `<tr><td style="padding-left:16px">${L("calendarPumpEnergy")}</td><td class="val">${formatEnergyLong(totalPumpEnergy)}</td></tr>` : ""}
    ${HEATER_WATTS > 0 && totalHeaterEnergy > 0 ? `<tr><td style="padding-left:16px">${L("calendarHeaterEnergy")}</td><td class="val">${formatEnergyLong(totalHeaterEnergy)}</td></tr>` : ""}
    ${ENERGY_COST_RATE > 0 && (totalPumpEnergy + totalHeaterEnergy) > 0 ? `<tr><td>${L("calendarEnergyCost")}</td><td class="val">${formatCost(totalPumpEnergy + totalHeaterEnergy)}</td></tr>` : ""}
    ${ENERGY_COST_RATE > 0 && totalPumpEnergy > 0 && totalHeaterEnergy > 0 ? `<tr><td style="padding-left:16px">${L("calendarPumpEnergyCost")}</td><td class="val">${formatCost(totalPumpEnergy)}</td></tr>` : ""}
    ${ENERGY_COST_RATE > 0 && totalPumpEnergy > 0 && totalHeaterEnergy > 0 ? `<tr><td style="padding-left:16px">${L("calendarHeaterEnergyCost")}</td><td class="val">${formatCost(totalHeaterEnergy)}</td></tr>` : ""}
    ${WATER_COST_RATE > 0 && totalFlow > 0 ? `<tr><td>${L("calendarWaterCost")}</td><td class="val">${formatWaterCost(totalFlow)}</td></tr>` : ""}
  </table>
</div>
<form class="date-form" onsubmit="location.href='/calendar?view=month&date='+this.d.value;return false">
  <label style="font-size:0.8rem;color:#64748b">${L("calendarDate")}:</label>
  <input type="date" name="d" value="${anchorDate}" min="${oldestDate}" max="${latestDate}">
  <button type="submit">${L("calendarGo")}</button>
</form>
<p style="margin-top:16px"><a class="footer-link" href="/">${L("calendarBackToDashboard")}</a></p>
</body>
</html>`;
}

// ---- Settings Page ----

function getAvailableLocales(): { id: string; label: string }[] {
    const dirs = [
        join("locales"),
        join(dirname(process.argv[1] || "."), "locales"),
        join(dirname(process.argv[1] || "."), "..", "locales"),
    ];
    const seen = new Set<string>();
    const result: { id: string; label: string }[] = [];
    for (const dir of dirs) {
        if (!existsSync(dir)) { continue; }
        for (const f of readdirSync(dir)) {
            if (!f.endsWith(".json")) { continue; }
            const id = f.replace(".json", "");
            if (seen.has(id)) { continue; }
            seen.add(id);
            try {
                const data = JSON.parse(readFileSync(join(dir, f), "utf-8"));
                result.push({ id, label: data.pageTitle || id });
            } catch {
                result.push({ id, label: id });
            }
        }
    }
    if (result.length === 0) {
        result.push({ id: "en", label: "English" });
    }
    return result;
}

function saveConfig(updates: Partial<FlowConfig>): void {
    let cfg: FlowConfig = {};
    if (existsSync(CONFIG_FILE)) {
        try {
            cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
        } catch { /* start fresh */ }
    }
    Object.assign(cfg, updates);
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 4) + "\n");
}

function buildSettingsHtml(saved?: boolean): string {
    const locales = getAvailableLocales();

    const localeOptions = locales.map((loc) =>
        `<option value="${loc.id}"${loc.id === LOCALE_ID ? " selected" : ""}>${loc.label} (${loc.id})</option>`
    ).join("\n            ");

    const savedBanner = saved
        ? `<div style="background:#065f46;color:#6ee7b7;padding:12px 16px;border-radius:8px;margin-bottom:16px">${L("settingsSaved")}</div>`
        : "";

    return `<!DOCTYPE html>
<html lang="${LOCALE.langCode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${L("settingsTitle")}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background: #0f172a; color: #e2e8f0; padding: 24px; max-width: 520px; margin: 0 auto; }
  h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 20px; color: #94a3b8; }
  .card { background: #1e293b; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
  label { display: block; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em;
          color: #64748b; margin-bottom: 6px; margin-top: 16px; }
  label:first-child { margin-top: 0; }
  input[type="number"], select { width: 100%; padding: 8px 12px; border-radius: 6px; border: 1px solid #475569;
         background: #0f172a; color: #e2e8f0; font-size: 1rem; }
  .unit { color: #64748b; font-size: 0.85rem; margin-left: 8px; }
  .input-row { display: flex; align-items: center; }
  .input-row input { flex: 1; }
  .btn { display: inline-block; margin-top: 20px; padding: 10px 28px; border: none;
         border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer;
         background: #3b82f6; color: #fff; }
  .btn:hover { background: #2563eb; }
  a { color: #94a3b8; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>${L("settingsTitle")}</h1>
${savedBanner}
<form method="POST" action="/settings">
  <div class="card">
    <label>${L("settingPumpMaxRunTime")}</label>
    <div class="input-row">
      <input type="number" name="pumpMaxRunTime" value="${PUMP_MAX_RUN_TIME / MINUTE}" min="1" max="120" step="1">
      <span class="unit">${L("settingPumpMaxRunTimeUnit")}</span>
    </div>

    <label>${L("settingFlowStartDelay")}</label>
    <div class="input-row">
      <input type="number" name="flowStartDelay" value="${FLOW_START_DELAY / SECOND}" min="1" max="60" step="1">
      <span class="unit">${L("settingFlowStartDelayUnit")}</span>
    </div>

    <label>${L("settingFlowStopDelay")}</label>
    <div class="input-row">
      <input type="number" name="flowStopDelay" value="${FLOW_STOP_DELAY / SECOND}" min="1" max="60" step="1">
      <span class="unit">${L("settingFlowStopDelayUnit")}</span>
    </div>

    <label>${L("settingPumpWatts")}</label>
    <div class="input-row">
      <input type="number" name="pumpWatts" value="${PUMP_WATTS}" min="0" max="50000" step="1">
      <span class="unit">${L("settingWattsUnit")}</span>
    </div>

    <label>${L("settingHeaterWatts")}</label>
    <div class="input-row">
      <input type="number" name="heaterWatts" value="${HEATER_WATTS}" min="0" max="50000" step="1">
      <span class="unit">${L("settingWattsUnit")}</span>
    </div>

    <label>${L("settingHeaterTempSetting")}</label>
    <div class="input-row">
      <input type="number" name="heaterTempSetting" value="${TEMP_UNITS === "F" ? Math.round(cToF(HEATER_TEMP_SETTING)) : HEATER_TEMP_SETTING}" min="0" max="${TEMP_UNITS === "F" ? 212 : 100}" step="1">
      <span class="unit">${TEMP_UNITS === "F" ? "\u00b0F" : "\u00b0C"}</span>
    </div>

    <label>${L("settingEnergyCostRate")}</label>
    <div class="input-row">
      <input type="number" name="energyCostRate" value="${ENERGY_COST_RATE}" min="0" max="9999" step="0.01">
      <span class="unit">/kWh</span>
    </div>

    <label>${L("settingEnergyCostCurrency")}</label>
    <select name="energyCostCurrency">
      <option value="$"${ENERGY_COST_CURRENCY === "$" ? " selected" : ""}>$ (${L("currencyDollar")})</option>
      <option value="€"${ENERGY_COST_CURRENCY === "€" ? " selected" : ""}>€ (${L("currencyEuro")})</option>
      <option value="¥"${ENERGY_COST_CURRENCY === "¥" ? " selected" : ""}>¥ (${L("currencyYen")})</option>
    </select>

    <label>${L("settingWaterCostRate")}</label>
    <div class="input-row">
      <input type="number" name="waterCostRate" value="${WATER_COST_RATE}" min="0" max="9999" step="0.01">
      <span class="unit">/1000 ${FLOW_UNITS === "G" ? "gal" : "L"}</span>
    </div>
  </div>

  <div class="card">
    <label>${L("settingLocale")}</label>
    <select name="locale">
      ${localeOptions}
    </select>

    <label>${L("settingTempUnits")}</label>
    <select name="tempUnits">
      <option value="C"${TEMP_UNITS === "C" ? " selected" : ""}>${L("settingTempC")}</option>
      <option value="F"${TEMP_UNITS === "F" ? " selected" : ""}>${L("settingTempF")}</option>
    </select>

    <label>${L("settingFlowUnits")}</label>
    <select name="flowUnits">
      <option value="L"${FLOW_UNITS === "L" ? " selected" : ""}>${L("settingFlowL")}</option>
      <option value="G"${FLOW_UNITS === "G" ? " selected" : ""}>${L("settingFlowG")}</option>
    </select>
  </div>

  <div class="card">
    <label>${L("settingDoorMonitor")}</label>
    <select name="doorMonitorEnabled" onchange="document.getElementById('door-homekit-warn').style.display=this.value!=='${DOOR_MONITOR_ENABLED ? "1" : "0"}'?'block':'none'">
      <option value="0"${!DOOR_MONITOR_ENABLED ? " selected" : ""}>${L("settingDoorDisabled")}</option>
      <option value="1"${DOOR_MONITOR_ENABLED ? " selected" : ""}>${L("settingDoorEnabled")}</option>
    </select>
    <p id="door-homekit-warn" style="display:none;color:#f59e0b;font-size:0.85rem;margin-top:8px">${L("settingDoorHomekitWarning")}</p>
    ${[1, 2].map((i) =>
        `<label>${L("settingDoorName", { id: String(i) })}</label>
    <input type="text" name="doorName${i}" value="${DOOR_NAMES[String(i)] || ""}" placeholder="${L("settingDoorNamePlaceholder")}"
           style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:1rem">`
    ).join("\n    ")}
  </div>

  <button type="submit" class="btn">${L("settingSave")}</button>
</form>
<p style="margin-top:16px"><a href="/sensor-setup">${L("sensorSetup")}</a></p>
<p style="margin-top:8px"><a href="/">${L("settingsBackToDashboard")}</a></p>
</body>
</html>`;
}

function buildSensorSetupHtml(
    sensors: { deviceId: string | undefined; name: string; celsius: number | undefined }[],
    missing: { id: string; role: string }[],
    saved?: boolean,
    error?: string,
): string {
    const roleOptions = (selected: string | undefined) =>
        [`<option value="">${L("sensorRoleNone")}</option>`,
        ...VALID_SENSOR_ROLES.map((r) =>
            `<option value="${r}"${r === selected ? " selected" : ""}>${sensorDisplayName(r)}</option>`
        )].join("");

    const sensorRows = sensors.map((s) => {
        const currentRole = s.deviceId && sensorConfig ? sensorConfig.sensors[s.deviceId] : undefined;
        const tempStr = s.celsius !== undefined ? ` (${formatTemp(s.celsius)})` : "";
        return `<div class="sensor-row">
      <div class="sensor-id">${s.deviceId || "?"}<span class="sensor-temp">${tempStr}</span></div>
      <select name="role_${s.deviceId || ""}">${roleOptions(currentRole)}</select>
    </div>`;
    }).join("\n    ");

    const missingHtml = missing.map((m) =>
        `<div class="missing">${L("sensorMissing", { id: m.id, role: sensorDisplayName(m.role) })}</div>`
    ).join("\n    ");

    const savedBanner = saved
        ? `<div class="banner ok">${L("sensorSaved")}</div>`
        : "";
    const errorBanner = error
        ? `<div class="banner err">${error}</div>`
        : "";

    return `<!DOCTYPE html>
<html lang="${LOCALE.langCode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${L("sensorSetupTitle")}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background: #0f172a; color: #e2e8f0; padding: 24px; max-width: 520px; margin: 0 auto; }
  h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 8px; color: #94a3b8; }
  .desc { color: #64748b; font-size: 0.85rem; margin-bottom: 16px; }
  .card { background: #1e293b; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
  .sensor-row { margin-bottom: 14px; }
  .sensor-id { font-family: monospace; font-size: 0.85rem; color: #94a3b8; margin-bottom: 4px; }
  .sensor-temp { color: #64748b; margin-left: 8px; }
  select { width: 100%; padding: 8px 12px; border-radius: 6px; border: 1px solid #475569;
           background: #0f172a; color: #e2e8f0; font-size: 1rem; }
  .btn { display: inline-block; margin-top: 16px; padding: 10px 28px; border: none;
         border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer;
         background: #3b82f6; color: #fff; }
  .btn:hover { background: #2563eb; }
  .banner { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; }
  .banner.ok { background: #065f46; color: #6ee7b7; }
  .banner.err { background: #7f1d1d; color: #fca5a5; }
  .missing { background: #7f1d1d; color: #fca5a5; padding: 10px 14px; border-radius: 8px; margin-bottom: 8px; font-size: 0.9rem; }
  a { color: #94a3b8; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>${L("sensorSetupTitle")}</h1>
<p class="desc">${L("sensorSetupDesc")}</p>
${savedBanner}${errorBanner}
${missingHtml}
<form method="POST" action="/sensor-setup">
  <div class="card">
    ${sensorRows}
  </div>
  <button type="submit" class="btn">${L("settingSave")}</button>
</form>
<p style="margin-top:16px"><a href="/settings">${L("sensorBackToSettings")}</a></p>
</body>
</html>`;
}

// ---- Wi-Fi Configuration ----

const WIFI_PASSWORDS_FILE = "wifi_passwords.json";

/** Encrypted store for WiFi passwords. Uses AES-256-GCM with a machine-derived key.
 *  Passwords are never exposed to the client — only a boolean indicating presence. */
class WifiPasswordStore {
    private readonly keyHex: string;

    constructor() {
        // Derive a stable encryption key from the machine ID or fallback to hostname.
        // This isn't meant to resist a determined attacker with root access — it just
        // prevents casual reading of the JSON file.
        let seed: string;
        try {
            seed = readFileSync("/etc/machine-id", "utf-8").trim();
        } catch {
            seed = hostname();
        }
        this.keyHex = createHash("sha256").update(`oyu-wifi-${seed}`).digest("hex");
    }

    private encrypt(plaintext: string): string {
        const ivHex = randomBytes(12).toString("hex");
        const cipher = createCipheriv("aes-256-gcm",
            Buffer.from(this.keyHex, "hex") as never,
            Buffer.from(ivHex, "hex") as never);
        let encrypted = cipher.update(plaintext, "utf8", "hex");
        encrypted += cipher.final("hex");
        const tagHex = cipher.getAuthTag().toString("hex");
        return ivHex + ":" + tagHex + ":" + encrypted;
    }

    private decrypt(stored: string): string | undefined {
        try {
            const [ivHex, tagHex, dataHex] = stored.split(":");
            const decipher = createDecipheriv("aes-256-gcm",
                Buffer.from(this.keyHex, "hex") as never,
                Buffer.from(ivHex, "hex") as never);
            decipher.setAuthTag(Buffer.from(tagHex, "hex") as never);
            let decrypted = decipher.update(dataHex, "hex", "utf8");
            decrypted += decipher.final("utf8");
            return decrypted;
        } catch {
            return undefined;
        }
    }

    private load(): Record<string, string> {
        try {
            return JSON.parse(readFileSync(WIFI_PASSWORDS_FILE, "utf-8"));
        } catch {
            return {};
        }
    }

    private save(data: Record<string, string>): void {
        writeFileSync(WIFI_PASSWORDS_FILE, JSON.stringify(data, null, 2) + "\n");
    }

    /** Save or update an encrypted password for an SSID. */
    public set(ssid: string, password: string): void {
        const data = this.load();
        data[ssid] = this.encrypt(password);
        this.save(data);
    }

    /** Retrieve the decrypted password for an SSID, or undefined if not stored. */
    public get(ssid: string): string | undefined {
        const data = this.load();
        const stored = data[ssid];
        return stored ? this.decrypt(stored) : undefined;
    }

    /** Check whether a password is stored for an SSID. */
    public has(ssid: string): boolean {
        const data = this.load();
        return ssid in data;
    }

    /** Get the set of SSIDs that have saved passwords. */
    public allSSIDs(): Set<string> {
        return new Set(Object.keys(this.load()));
    }
}

const wifiPasswords = new WifiPasswordStore();

interface WifiNetwork {
    ssid: string;
    quality: number;
    security: string[];
    known?: boolean;
    hasSavedPassword?: boolean;
}

async function scanWifiNetworks(): Promise<WifiNetwork[]> {
    const networks = await si.wifiNetworks();
    const arr = Array.isArray(networks) ? networks : [networks];
    // Filter to open or WPA2, deduplicate by SSID keeping strongest signal
    const seen = new Map<string, WifiNetwork>();
    for (const net of arr) {
        if (!net.ssid) { continue; }
        const secArr: string[] = Array.isArray(net.security) ? net.security : [];
        const hasWpa2 = secArr.some((s: string) => /wpa.*2|wpa2/i.test(s));
        const isOpen = secArr.length === 0 || secArr.every((s: string) => /none|open/i.test(s));
        if (!hasWpa2 && !isOpen) { continue; }
        const existing = seen.get(net.ssid);
        if (!existing || net.quality > existing.quality) {
            seen.set(net.ssid, { ssid: net.ssid, quality: net.quality, security: secArr });
        }
    }
    // Sort alphabetically by SSID for stable ordering
    return Array.from(seen.values()).sort((a, b) => a.ssid.localeCompare(b.ssid));
}

/** Get SSIDs of saved WiFi connection profiles with autoconnect enabled. */
function getKnownSSIDs(): Set<string> {
    const known = new Set<string>();
    if (!IS_LINUX) { return known; }
    try {
        // List saved wifi connections: NAME:TYPE:AUTOCONNECT
        const out = execSync("nmcli -t -f NAME,TYPE,AUTOCONNECT connection show",
            { timeout: 5000, stdio: "pipe" }).toString().trim();
        for (const line of out.split("\n")) {
            const parts = line.split(":");
            if (parts.length >= 3 && parts[1] === "802-11-wireless" && parts[2] === "yes") {
                // Profile names are "oyu-<ssid>" — extract the SSID
                const name = parts[0];
                const ssid = name.startsWith("oyu-") ? name.slice(4) : name;
                known.add(ssid);
            }
        }
    } catch { /* ignore */ }
    return known;
}

/** Tag scanned networks with known status and saved password presence. */
function tagKnownNetworks(networks: WifiNetwork[]): WifiNetwork[] {
    const known = getKnownSSIDs();
    const saved = wifiPasswords.allSSIDs();
    return networks.map((n) => ({
        ...n,
        known: known.has(n.ssid),
        hasSavedPassword: saved.has(n.ssid),
    }));
}

/** Check whether an active Ethernet connection with an IP address is present.
 *  Uses `ip addr` instead of nmcli since eth0 may not be managed by NetworkManager. */
function hasEthernetConnection(): boolean {
    if (!IS_LINUX) { return false; }
    try {
        // Look for eth* or en* interfaces that are UP and have an IPv4 address
        const out = execSync("ip -o addr show",
            { timeout: 5000, stdio: "pipe" }).toString();
        for (const line of out.split("\n")) {
            // Format: "2: eth0    inet 192.168.1.100/24 ..."
            const match = line.match(/^\d+:\s+(eth\S+|en\S+)\s+inet\s+/);
            if (match) { return true; }
        }
    } catch { /* ignore */ }
    return false;
}

function isOpenNetwork(security: string[]): boolean {
    return security.length === 0 || security.every((s) => /none|open/i.test(s));
}

function buildWifiHtml(networks: WifiNetwork[], currentSSID?: string, message?: { text: string; success: boolean }, apMode = false, networkInfo?: NetworkInfo, wifiOff = false, ethPresent = false, clientVia?: "Ethernet" | "Wi-Fi"): string {
    const apBanner = apMode
        ? `<div style="background:#1e3a5f;color:#93c5fd;padding:12px 16px;border-radius:8px;margin-bottom:16px;border:1px solid #3b82f6">${L("wifiApMode")}</div>`
        : "";
    const banner = message
        ? `<div style="background:${message.success ? "#065f46" : "#7f1d1d"};color:${message.success ? "#6ee7b7" : "#fca5a5"};padding:12px 16px;border-radius:8px;margin-bottom:16px">${message.text}</div>`
        : "";

    function buildRow(net: WifiNetwork): string {
        const isCurrent = net.ssid === currentSSID;
        const open = isOpenNetwork(net.security);
        const secLabel = open ? L("wifiOpen") : L("wifiSecured");
        const signalBars = net.quality >= 75 ? "████" : net.quality >= 50 ? "███░" : net.quality >= 25 ? "██░░" : "█░░░";
        const highlight = isCurrent ? ' style="background:#1a3a2a;opacity:0.7"' : "";
        const currentBadge = isCurrent ? ` <span style="color:#4ade80;font-size:0.75rem">●&nbsp;${L("wifiConnected")}</span>` : "";
        const clickAttr = isCurrent ? "" : ` onclick="selectNetwork(this)"`;
        const cursorStyle = isCurrent ? " style=\"cursor:default\"" : "";
        return `<div class="wifi-net${isCurrent ? " wifi-current" : ""}"${highlight} data-ssid="${net.ssid.replace(/"/g, "&quot;")}" data-open="${open}" data-known="${!!net.known}" data-saved="${!!net.hasSavedPassword}"${clickAttr}${cursorStyle}>
  <div class="wifi-row">
    <span class="wifi-ssid">${net.ssid}${currentBadge}</span>
    <span class="wifi-meta"><span class="signal">${signalBars}</span> <span class="sec">${secLabel}</span></span>
  </div>
</div>\n`;
    }

    let networkRows = "";
    if (networks.length === 0) {
        networkRows = `<p class="muted">${L("wifiNoNetworks")}</p>`;
    } else {
        const known = networks.filter((n) => n.known).sort((a, b) => a.ssid.localeCompare(b.ssid));
        const other = networks.filter((n) => !n.known).sort((a, b) => a.ssid.localeCompare(b.ssid));
        if (known.length > 0) {
            networkRows += `<label class="section-label">${L("wifiKnownNetworks")}</label>\n`;
            for (const net of known) { networkRows += buildRow(net); }
        }
        if (other.length > 0) {
            networkRows += `<label class="section-label">${L("wifiOtherNetworks")}</label>\n`;
            for (const net of other) { networkRows += buildRow(net); }
        }
    }

    return `<!DOCTYPE html>
<html lang="${LOCALE.langCode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${L("wifiTitle")}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background: #0f172a; color: #e2e8f0; padding: 24px; max-width: 520px; margin: 0 auto; }
  h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 20px; color: #94a3b8; }
  .card { background: #1e293b; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
  .muted { color: #64748b; font-size: 0.85rem; }
  .warning { background: #422006; color: #fbbf24; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.85rem; }
  .wifi-net { padding: 12px 16px; border-radius: 8px; cursor: pointer; margin-bottom: 4px; }
  .wifi-net:not(.wifi-current):hover { background: #334155; }
  .wifi-row { display: flex; justify-content: space-between; align-items: center; }
  .wifi-ssid { font-weight: 600; font-size: 1rem; }
  .wifi-meta { font-size: 0.8rem; color: #94a3b8; }
  .signal { font-family: monospace; letter-spacing: -1px; }
  .sec { margin-left: 8px; }
  .selected { background: #334155 !important; border: 1px solid #3b82f6; }
  #connect-form { display: none; margin-top: 16px; }
  #connect-form.visible { display: block; }
  label { display: block; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em;
          color: #64748b; margin-bottom: 6px; }
  input[type="text"], input[type="password"] { width: 100%; padding: 8px 12px; border-radius: 6px;
         border: 1px solid #475569; background: #0f172a; color: #e2e8f0; font-size: 1rem; }
  .pw-row { display: flex; align-items: center; gap: 8px; }
  .pw-row input { flex: 1; }
  .pw-toggle { background: #475569; color: #e2e8f0; border: none; border-radius: 6px;
               padding: 8px 12px; cursor: pointer; font-size: 0.85rem; white-space: nowrap; }
  .btn { display: inline-block; margin-top: 16px; padding: 10px 28px; border: none;
         border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer;
         background: #3b82f6; color: #fff; }
  .btn:hover { background: #2563eb; }
  .btn:disabled { background: #475569; cursor: not-allowed; }
  a { color: #94a3b8; font-size: 0.85rem; }
  #selected-ssid { font-weight: 600; color: #f8fafc; }
  .section-label { margin-top: 12px; margin-bottom: 4px; display: block; }
  table { border-collapse: collapse; }
  table td { padding: 6px 0; border-bottom: 1px solid #334155; }
  h2 { font-size: 1rem; color: #94a3b8; margin-bottom: 12px; }
  .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                   background: rgba(0,0,0,0.7); z-index: 1000; justify-content: center; align-items: center; }
  .modal-overlay.visible { display: flex; }
  .modal { background: #1e293b; border-radius: 12px; padding: 32px 28px; text-align: center;
           max-width: 340px; width: 90%; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
  .modal-title { font-size: 1.1rem; font-weight: 600; color: #e2e8f0; margin-bottom: 8px; }
  .modal-ssid { font-size: 1rem; color: #3b82f6; font-weight: 600; margin-bottom: 16px; }
  .modal-spinner { display: inline-block; width: 28px; height: 28px; border: 3px solid #475569;
                   border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite;
                   margin-bottom: 16px; }
  .modal-result { font-size: 1rem; margin-bottom: 16px; }
  .modal-result.success { color: #6ee7b7; }
  .modal-result.fail { color: #fca5a5; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<h1>${L("wifiTitle")}</h1>
${apBanner}${banner}
${wifiOff ? `<div style="background:#1e293b;padding:20px;border-radius:10px;margin-bottom:16px;text-align:center">
  <p style="margin-bottom:16px;font-size:1.1rem">${L("wifiOff")}</p>
  <button class="btn" style="background:#065f46" onclick="doWifiAction('enable_wifi')">${L("wifiTurnOn")}</button>
</div>` : `<div id="wifi-status" style="background:${currentSSID ? "#1a3a2a" : "#2a1a1a"};color:${currentSSID ? "#6ee7b7" : "#fca5a5"};padding:12px 16px;border-radius:8px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center">
  <span id="wifi-status-text">${currentSSID ? `${L("wifi")}: <strong>${currentSSID}</strong>` : L("wifiNotConnected")}</span>
  <span>
    ${currentSSID ? `<button class="btn" style="margin:0;padding:6px 16px;font-size:0.85rem;background:#7f1d1d" onclick="doDisconnect()">${L("wifiDisconnect")}</button>` : ""}
    <button class="btn" id="wifi-off-btn" style="margin:0 0 0 8px;padding:6px 16px;font-size:0.85rem;background:#475569" onclick="doWifiAction('disable_wifi')"${ethPresent ? "" : " disabled"}>${L("wifiTurnOff")}</button>
  </span>
</div>
<div class="warning">${apMode ? "" : L("wifiDisconnectWarning")}</div>
<div class="card">
  <span id="scan-indicator" class="muted"></span>
  <div id="network-list">${networkRows}</div>
</div>
<div id="connect-form">
  <div class="card">
    <p style="margin-bottom:12px">${L("networkConnection")}: <span id="selected-ssid"></span></p>
    <div id="saved-pw-hint" style="display:none;margin-bottom:12px">
      <p class="muted" style="font-size:0.85rem">${L("wifiSavedPassword")}</p>
    </div>
    <div id="password-section">
      <label>${L("wifiPassword")}</label>
      <div class="pw-row">
        <input type="password" id="wifi-pw" name="password" autocomplete="off">
        <button type="button" class="pw-toggle" onclick="togglePw()">${L("wifiShowPassword")}</button>
      </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <button class="btn" id="connect-btn" onclick="doConnect()">${L("wifiConnect")}</button>
      <button class="btn" id="reconnect-btn" style="display:none;background:#065f46" onclick="doReconnect()">${L("wifiReconnect")}</button>
    </div>
  </div>
</div>`}
<div class="card" id="network-info">
  <h2>${L("network")}</h2>
  ${networkInfo ? `<table style="width:100%">
${clientVia ? `    <tr><td class="muted">${L("networkDashboardVia")}</td><td style="text-align:right"><span style="color:${clientVia === "Wi-Fi" ? "#38bdf8" : "#4ade80"}">${clientVia}</span></td></tr>\n` : ""}\
    <tr><td class="muted">${L("networkConnection")}</td><td style="text-align:right">${networkInfo.ConnectionType}</td></tr>
${networkInfo.SSID ? `    <tr><td class="muted">${L("networkSSID")}</td><td style="text-align:right">${networkInfo.SSID}</td></tr>\n` : ""}\
    <tr><td class="muted">${L("networkIP")}</td><td style="text-align:right">${networkInfo.IP}</td></tr>
    <tr><td class="muted">${L("networkMAC")}</td><td style="text-align:right">${networkInfo.MAC}</td></tr>
    <tr><td class="muted">${L("networkSubnet")}</td><td style="text-align:right">${networkInfo.Subnet}</td></tr>
    <tr><td class="muted">${L("networkGateway")}</td><td style="text-align:right">${networkInfo.Gateway}</td></tr>
  </table>` : `<p class="muted">${L("networkUnavailable")}</p>`}
</div>
${apMode ? "" : `<p style="margin-top:16px"><a href="/">${L("wifiBackToDashboard")}</a></p>`}
<div class="modal-overlay" id="connect-modal">
  <div class="modal">
    <div class="modal-title" id="modal-title">${L("wifiConnecting")}</div>
    <div class="modal-ssid" id="modal-ssid"></div>
    <div class="modal-spinner" id="modal-spinner"></div>
    <div class="modal-result" id="modal-result" style="display:none"></div>
    <button class="btn" id="modal-cancel-btn" style="background:#7f1d1d;margin-top:0" onclick="cancelConnect()">${L("wifiCancel")}</button>
    <button class="btn" id="modal-ok-btn" style="display:none;margin-top:0" onclick="dismissModal()">OK</button>
  </div>
</div>
<script>
var selectedSSID = "";
var selectedOpen = false;
var selectedSaved = false;
var scanTimer = null;
var pageTimeout = null;
var typingPauseUntil = 0;
var L_open = ${JSON.stringify(L("wifiOpen"))};
var L_secured = ${JSON.stringify(L("wifiSecured"))};
var L_connecting = ${JSON.stringify(L("wifiConnecting"))};
var L_wifi = ${JSON.stringify(L("wifi"))};
var L_notConnected = ${JSON.stringify(L("wifiNotConnected"))};
var L_disconnect = ${JSON.stringify(L("wifiDisconnect"))};
var L_knownNetworks = ${JSON.stringify(L("wifiKnownNetworks"))};
var L_otherNetworks = ${JSON.stringify(L("wifiOtherNetworks"))};
var L_network = ${JSON.stringify(L("network"))};
var L_netConn = ${JSON.stringify(L("networkConnection"))};
var L_netSSID = ${JSON.stringify(L("networkSSID"))};
var L_netIP = ${JSON.stringify(L("networkIP"))};
var L_netMAC = ${JSON.stringify(L("networkMAC"))};
var L_netSubnet = ${JSON.stringify(L("networkSubnet"))};
var L_netGateway = ${JSON.stringify(L("networkGateway"))};
var L_netUnavailable = ${JSON.stringify(L("networkUnavailable"))};
var L_connected = ${JSON.stringify(L("wifiConnected"))};
var L_connectFailed = ${JSON.stringify(L("wifiConnectFailed"))};
var currentSSID = ${currentSSID ? JSON.stringify(currentSSID) : "null"};

function selectNetwork(el) {
  document.querySelectorAll(".wifi-net").forEach(function(n) { n.classList.remove("selected"); });
  el.classList.add("selected");
  selectedSSID = el.getAttribute("data-ssid");
  selectedOpen = el.getAttribute("data-open") === "true";
  selectedSaved = el.getAttribute("data-saved") === "true";
  document.getElementById("selected-ssid").textContent = selectedSSID;
  document.getElementById("connect-form").classList.add("visible");
  document.getElementById("wifi-pw").value = "";
  var pwSection = document.getElementById("password-section");
  pwSection.style.display = selectedOpen ? "none" : "block";
  var savedHint = document.getElementById("saved-pw-hint");
  var reconnectBtn = document.getElementById("reconnect-btn");
  if (selectedSaved && !selectedOpen) {
    savedHint.style.display = "block";
    reconnectBtn.style.display = "inline-block";
  } else {
    savedHint.style.display = "none";
    reconnectBtn.style.display = "none";
  }
  if (!selectedOpen) { document.getElementById("wifi-pw").focus(); }
}
function togglePw() {
  var inp = document.getElementById("wifi-pw");
  var btn = event.target;
  if (inp.type === "password") {
    inp.type = "text";
    btn.textContent = ${JSON.stringify(L("wifiHidePassword"))};
  } else {
    inp.type = "password";
    btn.textContent = ${JSON.stringify(L("wifiShowPassword"))};
  }
}
var connectAbort = null;

function showConnectModal(ssid) {
  stopScanning();
  document.getElementById("modal-ssid").textContent = ssid;
  document.getElementById("modal-title").textContent = L_connecting;
  document.getElementById("modal-spinner").style.display = "inline-block";
  document.getElementById("modal-result").style.display = "none";
  document.getElementById("modal-cancel-btn").style.display = "inline-block";
  document.getElementById("modal-ok-btn").style.display = "none";
  document.getElementById("connect-modal").classList.add("visible");
}

function showModalResult(success, message) {
  document.getElementById("modal-spinner").style.display = "none";
  var result = document.getElementById("modal-result");
  result.textContent = message;
  result.className = "modal-result " + (success ? "success" : "fail");
  result.style.display = "block";
  document.getElementById("modal-cancel-btn").style.display = "none";
  document.getElementById("modal-ok-btn").style.display = "inline-block";
}

function dismissModal() {
  document.getElementById("connect-modal").classList.remove("visible");
  location.href = "/wifi";
}

function cancelConnect() {
  if (connectAbort) { connectAbort.abort(); connectAbort = null; }
  document.getElementById("connect-modal").classList.remove("visible");
  startScanning();
}

function doWifiPost(params) {
  connectAbort = new AbortController();
  var body = new URLSearchParams(params).toString();
  fetch("/wifi", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: body,
    signal: connectAbort.signal
  }).then(function(r) { return r.json(); }).then(function(data) {
    connectAbort = null;
    showModalResult(data.success, data.message);
  }).catch(function(err) {
    connectAbort = null;
    if (err.name === "AbortError") { return; }
    showModalResult(false, err.message || L_connectFailed);
  });
}

function doConnect() {
  showConnectModal(selectedSSID);
  var pw = selectedOpen ? "" : document.getElementById("wifi-pw").value;
  doWifiPost({ ssid: selectedSSID, password: pw });
}

function doReconnect() {
  showConnectModal(selectedSSID);
  doWifiPost({ ssid: selectedSSID, action: "reconnect" });
}

function doDisconnect() {
  stopScanning();
  var form = document.createElement("form");
  form.method = "POST";
  form.action = "/wifi";
  var s = document.createElement("input");
  s.type = "hidden"; s.name = "action"; s.value = "disconnect";
  form.appendChild(s);
  document.body.appendChild(form);
  form.submit();
}

function doWifiAction(action) {
  stopScanning();
  var form = document.createElement("form");
  form.method = "POST";
  form.action = "/wifi";
  var s = document.createElement("input");
  s.type = "hidden"; s.name = "action"; s.value = action;
  form.appendChild(s);
  document.body.appendChild(form);
  form.submit();
}

function signalBars(q) {
  return q >= 75 ? "\\u2588\\u2588\\u2588\\u2588" : q >= 50 ? "\\u2588\\u2588\\u2588\\u2591" : q >= 25 ? "\\u2588\\u2588\\u2591\\u2591" : "\\u2588\\u2591\\u2591\\u2591";
}
function isOpen(sec) {
  if (!sec || sec.length === 0) return true;
  return sec.every(function(s) { return /none|open/i.test(s); });
}
function buildNetworkRow(net) {
  var cur = net.ssid === currentSSID;
  var open = isOpen(net.security);
  var secLabel = open ? L_open : L_secured;
  var bars = signalBars(net.quality);
  var cls = "wifi-net" + (cur ? " wifi-current" : "") + (net.ssid === selectedSSID ? " selected" : "");
  var style = cur ? ' style="background:#1a3a2a;opacity:0.7;cursor:default"' : "";
  var click = cur ? "" : ' onclick="selectNetwork(this)"';
  var badge = cur ? ' <span style="color:#4ade80;font-size:0.75rem">\\u25CF&nbsp;' + L_connected + '</span>' : "";
  var saved = !!net.hasSavedPassword;
  return '<div class="' + cls + '"' + style + ' data-ssid="' + net.ssid.replace(/"/g, "&quot;") + '" data-open="' + open + '" data-saved="' + saved + '"' + click + '>' +
    '<div class="wifi-row"><span class="wifi-ssid">' + net.ssid + badge + '</span>' +
    '<span class="wifi-meta"><span class="signal">' + bars + '</span> <span class="sec">' + secLabel + '</span></span></div></div>';
}
function updateNetworkInfo(info) {
  var el = document.getElementById("network-info");
  if (!el) return;
  var html = "<h2>" + L_network + "</h2>";
  if (info) {
    html += '<table style="width:100%">';
    html += '<tr><td class="muted">' + L_netConn + '</td><td style="text-align:right">' + info.ConnectionType + '</td></tr>';
    if (info.SSID) { html += '<tr><td class="muted">' + L_netSSID + '</td><td style="text-align:right">' + info.SSID + '</td></tr>'; }
    html += '<tr><td class="muted">' + L_netIP + '</td><td style="text-align:right">' + info.IP + '</td></tr>';
    html += '<tr><td class="muted">' + L_netMAC + '</td><td style="text-align:right">' + info.MAC + '</td></tr>';
    html += '<tr><td class="muted">' + L_netSubnet + '</td><td style="text-align:right">' + info.Subnet + '</td></tr>';
    html += '<tr><td class="muted">' + L_netGateway + '</td><td style="text-align:right">' + info.Gateway + '</td></tr>';
    html += '</table>';
  } else {
    html += '<p class="muted">' + L_netUnavailable + '</p>';
  }
  el.innerHTML = html;
}
function refreshNetworks() {
  if (Date.now() < typingPauseUntil) { return; }
  var indicator = document.getElementById("scan-indicator");
  indicator.textContent = "\\u21bb";
  fetch("/wifi/scan").then(function(r) { return r.json(); }).then(function(data) {
    indicator.textContent = "";
    currentSSID = data.currentSSID;
    // Update connection status bar
    var statusEl = document.getElementById("wifi-status");
    var statusText = document.getElementById("wifi-status-text");
    if (currentSSID) {
      statusEl.style.background = "#1a3a2a";
      statusEl.style.color = "#6ee7b7";
      statusText.innerHTML = L_wifi + ": <strong>" + currentSSID + "</strong>";
      if (!statusEl.querySelector(".btn")) {
        var btn = document.createElement("button");
        btn.className = "btn";
        btn.style.cssText = "margin:0;padding:6px 16px;font-size:0.85rem;background:#7f1d1d";
        btn.textContent = L_disconnect;
        btn.onclick = doDisconnect;
        statusEl.appendChild(btn);
      }
    } else {
      statusEl.style.background = "#2a1a1a";
      statusEl.style.color = "#fca5a5";
      statusText.textContent = L_notConnected;
      var existingBtn = statusEl.querySelector(".btn");
      if (existingBtn) { existingBtn.remove(); }
    }
    var list = document.getElementById("network-list");
    var nets = data.networks;
    var known = [];
    var other = [];
    for (var i = 0; i < nets.length; i++) {
      if (nets[i].known) { known.push(nets[i]); } else { other.push(nets[i]); }
    }
    known.sort(function(a,b) { return a.ssid.localeCompare(b.ssid); });
    other.sort(function(a,b) { return a.ssid.localeCompare(b.ssid); });
    var html = "";
    if (known.length > 0) {
      html += '<label class="section-label">' + L_knownNetworks + '</label>';
      for (var k = 0; k < known.length; k++) { html += buildNetworkRow(known[k]); }
    }
    if (other.length > 0) {
      html += '<label class="section-label">' + L_otherNetworks + '</label>';
      for (var o = 0; o < other.length; o++) { html += buildNetworkRow(other[o]); }
    }
    if (html) { list.innerHTML = html; }
    // If previously selected SSID is gone, hide connect form
    if (selectedSSID) {
      var still = list.querySelector('[data-ssid="' + selectedSSID.replace(/"/g, '\\\\"') + '"]');
      if (!still) {
        selectedSSID = "";
        document.getElementById("connect-form").classList.remove("visible");
      }
    }
    // Update network info card
    updateNetworkInfo(data.networkInfo);
  }).catch(function() { indicator.textContent = ""; });
}
function startScanning() {
  scanTimer = setInterval(refreshNetworks, 5000);
}
function stopScanning() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (pageTimeout) { clearTimeout(pageTimeout); pageTimeout = null; }
}
// Start polling and set 10-minute safety timeout (skip redirect in AP mode)
var pwInput = document.getElementById("wifi-pw");
if (pwInput) { pwInput.addEventListener("input", function() { typingPauseUntil = Date.now() + 10000; }); }
${wifiOff ? "// WiFi off — no scanning" : "startScanning();"}

${apMode ? "// AP mode: no timeout redirect — user must configure WiFi" : 'pageTimeout = setTimeout(function() { stopScanning(); window.location.href = "/"; }, 10 * 60 * 1000);'}
// Stop scanning when leaving the page
window.addEventListener("beforeunload", stopScanning);
</script>
</body>
</html>`;
}

function verifyWifiConnection(): boolean {
    // Check that wlan0 is actually connected
    try {
        const status = execSync("nmcli -t -f DEVICE,STATE dev", { timeout: 5000, stdio: "pipe" }).toString();
        for (const line of status.split("\n")) {
            const parts = line.split(":");
            if (parts[0] === "wlan0" && parts[1] === "connected") {
                return true;
            }
        }
    } catch { /* ignore */ }
    return false;
}

function connectToWifi(ssid: string, password: string): { success: boolean; error?: string } {
    // Use a fixed profile name to avoid accumulating profiles
    const profileName = `oyu-${ssid}`;
    try {
        // Delete any existing profile we may have created previously
        try {
            execSync(`nmcli connection delete ${JSON.stringify(profileName)}`,
                { timeout: 10000, stdio: "pipe" });
        } catch { /* no existing profile — fine */ }

        if (password) {
            // Create a WPA-PSK profile with autoconnect and activate it
            execSync(
                `nmcli connection add type wifi con-name ${JSON.stringify(profileName)}` +
                ` ssid ${JSON.stringify(ssid)}` +
                ` autoconnect yes` +
                ` wifi-sec.key-mgmt wpa-psk` +
                ` wifi-sec.psk ${JSON.stringify(password)}`,
                { timeout: 10000, stdio: "pipe" });
            execSync(`nmcli connection up ${JSON.stringify(profileName)}`,
                { timeout: 30000, stdio: "pipe" });
        } else {
            execSync(`nmcli device wifi connect ${JSON.stringify(ssid)}`,
                { timeout: 30000, stdio: "pipe" });
        }

        // Verify the connection actually established — nmcli can return success
        // before WiFi association and DHCP are fully complete
        if (!verifyWifiConnection()) {
            logger.log(LogSeverity.Important, LogArea.Server,
                `wifi: nmcli reported success but wlan0 not connected, waiting...`);
            // Give it a few more seconds
            let connected = false;
            for (let i = 0; i < 5; i++) {
                spawnSync("sleep", ["1"]);
                if (verifyWifiConnection()) {
                    connected = true;
                    break;
                }
            }
            if (!connected) {
                // Clean up the failed profile
                try {
                    execSync(`nmcli connection delete ${JSON.stringify(profileName)}`,
                        { timeout: 10000, stdio: "pipe" });
                } catch { /* ignore */ }
                return { success: false, error: "Connection activated but WiFi did not associate" };
            }
        }

        return { success: true };
    } catch (e) {
        // Clean up the profile on failure
        try {
            execSync(`nmcli connection delete ${JSON.stringify(profileName)}`,
                { timeout: 10000, stdio: "pipe" });
        } catch { /* ignore */ }
        const err = e as Error & { stderr?: Buffer };
        const msg = err.stderr ? err.stderr.toString().trim() : err.message;
        return { success: false, error: msg };
    }
}

function reconnectToWifi(ssid: string): boolean {
    try {
        // Use device wifi connect (by SSID) rather than connection up (by profile name),
        // since the profile name may differ from the SSID.
        execSync(`nmcli device wifi connect ${JSON.stringify(ssid)}`,
            { timeout: 30000, stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

// ---- Access Point ----

const AP_SSID = "hot water system";
const AP_INTERFACE = "wlan0";
/** Drop-in config for NetworkManager's dnsmasq to resolve all domains to the AP IP (captive portal). */
const DNSMASQ_CAPTIVE_CONF = "/etc/NetworkManager/dnsmasq-shared.d/oyu-captive.conf";

/** Manages a Wi-Fi access point for configuration when no network is available. */
class AccessPoint {
    private _active = false;
    private apIp: string | undefined;
    private serverPort: number | undefined;

    /** Whether the AP is currently running. */
    public get active(): boolean {
        return this._active;
    }

    /** Clean up any stale AP profile and captive portal config left from a previous crash.
     *  Should be called at startup before any network polling begins. */
    public cleanup(): void {
        if (!IS_LINUX) { return; }
        try {
            // Check if our AP profile exists
            const conns = execSync("nmcli -t -f NAME connection show", { timeout: 5000, stdio: "pipe" }).toString();
            if (conns.split("\n").some((line) => line.trim() === AP_SSID)) {
                logger.log(LogSeverity.Important, LogArea.Server,
                    `AP: found stale "${AP_SSID}" profile from previous run — removing`);
                try {
                    execSync(`nmcli connection down ${JSON.stringify(AP_SSID)}`, { timeout: 10000, stdio: "pipe" });
                } catch { /* may already be down */ }
                try {
                    execSync(`nmcli connection delete ${JSON.stringify(AP_SSID)}`, { timeout: 10000, stdio: "pipe" });
                    logger.log(LogSeverity.Important, LogArea.Server, "AP: stale profile deleted");
                } catch { /* ignore */ }
            }
            // Remove stale dnsmasq captive config
            if (existsSync(DNSMASQ_CAPTIVE_CONF)) {
                unlinkSync(DNSMASQ_CAPTIVE_CONF);
                logger.log(LogSeverity.Important, LogArea.Server, "AP: removed stale dnsmasq captive config");
            }
            // Remove stale iptables redirect
            this.removeIptablesRedirect();
        } catch (e) {
            logger.logError(LogSeverity.Info, LogArea.Server, e as Error, "AP: cleanup check failed");
        }
    }

    /** Start the access point hotspot and captive portal redirect.
     *  @param serverPort The HTTP server port to redirect captive portal traffic to. */
    public start(serverPort: number): void {
        if (this._active || !IS_LINUX) { return; }
        try {
            // Remove any previous hotspot profile
            try {
                execSync(`nmcli connection delete ${JSON.stringify(AP_SSID)}`,
                    { timeout: 10000, stdio: "pipe" });
                logger.log(LogSeverity.Detail, LogArea.Server, "AP: deleted previous hotspot profile");
            } catch { /* no existing profile */ }

            // Write dnsmasq drop-in config so NM's dnsmasq resolves all domains to the AP IP.
            // This is required for captive portal detection — without it, NM's dnsmasq returns
            // NXDOMAIN for external domains and devices never make HTTP requests to trigger iptables.
            // We use 10.42.0.1 as default; it gets updated after the AP is up if the actual IP differs.
            try {
                const confDir = dirname(DNSMASQ_CAPTIVE_CONF);
                if (!existsSync(confDir)) {
                    mkdirSync(confDir, { recursive: true });
                }
                writeFileSync(DNSMASQ_CAPTIVE_CONF, "address=/#/10.42.0.1\n");
                logger.log(LogSeverity.Info, LogArea.Server, `AP: wrote dnsmasq captive config`);
            } catch (e) {
                logger.logError(LogSeverity.Important, LogArea.Server, e as Error,
                    "AP: failed to write dnsmasq captive config");
            }

            // Create an open AP using connection profile (nmcli hotspot always requires WPA)
            const addCmd = `nmcli connection add type wifi con-name ${JSON.stringify(AP_SSID)}` +
                ` ifname ${AP_INTERFACE}` +
                ` ssid ${JSON.stringify(AP_SSID)}` +
                ` autoconnect no` +
                ` wifi.mode ap` +
                ` wifi.band bg` +
                ` ipv4.method shared`;
            logger.log(LogSeverity.Important, LogArea.Server, `AP: running: ${addCmd}`);
            const addOut = execSync(addCmd, { timeout: 15000, stdio: "pipe" });
            logger.log(LogSeverity.Important, LogArea.Server,
                `AP: add output: ${addOut.toString().trim()}`);

            const upCmd = `nmcli connection up ${JSON.stringify(AP_SSID)}`;
            logger.log(LogSeverity.Important, LogArea.Server, `AP: running: ${upCmd}`);
            const upOut = execSync(upCmd, { timeout: 15000, stdio: "pipe" });
            logger.log(LogSeverity.Important, LogArea.Server,
                `AP: up output: ${upOut.toString().trim()}`);

            // Verify the hotspot is actually up
            try {
                const devStatus = execSync(`nmcli -t -f TYPE,STATE,CONNECTION dev`,
                    { timeout: 5000, stdio: "pipe" }).toString().trim();
                logger.log(LogSeverity.Info, LogArea.Server, `AP: device status: ${devStatus}`);
            } catch { /* non-critical */ }

            // Get the AP's IP address for captive portal redirect
            this.apIp = this.getApIp();
            this.serverPort = serverPort;
            logger.log(LogSeverity.Important, LogArea.Server, `AP: interface IP = ${this.apIp || "not found"}`);

            // Update dnsmasq config with actual IP if different from default, then restart NM
            if (this.apIp && this.apIp !== "10.42.0.1") {
                try {
                    writeFileSync(DNSMASQ_CAPTIVE_CONF, `address=/#/${this.apIp}\n`);
                    execSync("nmcli general reload", { timeout: 5000, stdio: "pipe" });
                    logger.log(LogSeverity.Info, LogArea.Server,
                        `AP: updated dnsmasq captive config for IP ${this.apIp}`);
                } catch { /* non-critical */ }
            }

            // Set up iptables to redirect port 80 to our server port.
            if (this.apIp && serverPort !== 80) {
                this.addIptablesRedirect();
            }

            this._active = true;
            logger.log(LogSeverity.Important, LogArea.Server,
                `access point started: SSID="${AP_SSID}" IP=${this.apIp || "unknown"} → port ${serverPort}`);
        } catch (e) {
            const err = e as Error & { stderr?: Buffer; stdout?: Buffer };
            const stderr = err.stderr ? err.stderr.toString().trim() : "";
            const stdout = err.stdout ? err.stdout.toString().trim() : "";
            logger.log(LogSeverity.Severe, LogArea.Server,
                `AP: failed to start: ${err.message}${stderr ? ` stderr: ${stderr}` : ""}${stdout ? ` stdout: ${stdout}` : ""}`);
        }
    }

    /** Stop the access point and restore normal WiFi client mode. */
    public stop(): void {
        if (!this._active || !IS_LINUX) { return; }
        try {
            // Remove iptables redirect
            this.removeIptablesRedirect();

            // Remove dnsmasq captive portal config
            try {
                if (existsSync(DNSMASQ_CAPTIVE_CONF)) {
                    unlinkSync(DNSMASQ_CAPTIVE_CONF);
                    logger.log(LogSeverity.Info, LogArea.Server, "AP: removed dnsmasq captive config");
                }
            } catch { /* ignore */ }

            // Bring down the hotspot
            try {
                execSync(`nmcli connection down ${JSON.stringify(AP_SSID)}`,
                    { timeout: 10000, stdio: "pipe" });
                logger.log(LogSeverity.Info, LogArea.Server, "AP: hotspot brought down");
            } catch { /* may already be down */ }
            try {
                execSync(`nmcli connection delete ${JSON.stringify(AP_SSID)}`,
                    { timeout: 10000, stdio: "pipe" });
                logger.log(LogSeverity.Info, LogArea.Server, "AP: hotspot profile deleted");
            } catch { /* ignore */ }

            this._active = false;
            this.apIp = undefined;
            this.serverPort = undefined;
            logger.log(LogSeverity.Important, LogArea.Server, "access point stopped");
        } catch (e) {
            logger.logError(LogSeverity.Important, LogArea.Server, e as Error, "error stopping access point");
        }
    }

    /** Redirect HTTP port 80 on the AP interface to the server port via iptables PREROUTING + OUTPUT. */
    private addIptablesRedirect(): void {
        const port = this.serverPort!;
        const ip = this.apIp!;
        const rules = [
            // Redirect external clients hitting port 80 on the AP
            `iptables -t nat -A PREROUTING -i ${AP_INTERFACE} -p tcp --dport 80 -j REDIRECT --to-port ${port}`,
            // Redirect local connections to port 80 on the AP IP (for captive portal probes originating on-device)
            `iptables -t nat -A OUTPUT -p tcp -d ${ip} --dport 80 -j REDIRECT --to-port ${port}`,
        ];
        for (const rule of rules) {
            try {
                execSync(rule, { timeout: 5000, stdio: "pipe" });
                logger.log(LogSeverity.Info, LogArea.Server, `AP: ${rule}`);
            } catch (e) {
                const err = e as Error & { stderr?: Buffer };
                logger.log(LogSeverity.Important, LogArea.Server,
                    `AP: iptables rule failed: ${rule} — ${err.stderr ? err.stderr.toString().trim() : err.message}`);
            }
        }
    }

    /** Remove the iptables redirect rules added by addIptablesRedirect. */
    private removeIptablesRedirect(): void {
        if (!this.apIp || !this.serverPort) { return; }
        const port = this.serverPort;
        const ip = this.apIp;
        const rules = [
            `iptables -t nat -D PREROUTING -i ${AP_INTERFACE} -p tcp --dport 80 -j REDIRECT --to-port ${port}`,
            `iptables -t nat -D OUTPUT -p tcp -d ${ip} --dport 80 -j REDIRECT --to-port ${port}`,
        ];
        for (const rule of rules) {
            try {
                execSync(rule, { timeout: 5000, stdio: "pipe" });
                logger.log(LogSeverity.Info, LogArea.Server, `AP: removed: ${rule}`);
            } catch {
                // Rule may not exist — ignore
            }
        }
    }

    /** Get the IP address assigned to the AP interface. */
    private getApIp(): string | undefined {
        try {
            const out = execSync(`nmcli -t -f IP4.ADDRESS dev show ${AP_INTERFACE}`,
                { timeout: 5000, stdio: "pipe" }).toString().trim();
            // Output: "IP4.ADDRESS[1]:10.42.0.1/24"
            const match = out.match(/:([\d.]+)\//);
            return match ? match[1] : undefined;
        } catch {
            return undefined;
        }
    }
}

// ---- HTTP Server ----

class FlowHttpServer {
    private server: Server | undefined;
    private readonly sensors: SensorManager;
    public homekit: HomeKitBridge | undefined;
    private networkStatus: NetworkStatus = new NetworkStatus();
    private cachedNetworkInfo: NetworkInfo | undefined;
    private networkPollTimer: ReturnType<typeof setInterval> | undefined;
    private networkPollInFlight: Promise<void> | undefined;
    public readonly accessPoint: AccessPoint = new AccessPoint();
    /** Number of consecutive polls with no usable network. */
    private noNetworkCount = 0;
    private listeningPort = 0;
    /** How many consecutive failed polls before activating the AP. */
    private static readonly AP_ACTIVATE_POLLS = 2;
    /** Whether WiFi has been manually turned off (using Ethernet instead). */
    private wifiDisabled = false;

    constructor(sensors: SensorManager) {
        this.sensors = sensors;
    }

    public start(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
                this.handleRequest(req, res);
            });

            this.server.on("error", (e: Error) => {
                logger.logError(LogSeverity.Severe, LogArea.Server, e, "server error");
                reject(e);
            });

            this.server.listen(port, () => {
                this.listeningPort = port;
                logger.log(LogSeverity.Important, LogArea.Server, `flow server listening on port ${port}`);
                this.pollNetwork();
                this.networkPollTimer = setInterval(() => this.pollNetwork(), 30 * SECOND);
                resolve();
            });
        });
    }

    public async stop(): Promise<void> {
        if (this.networkPollTimer) {
            clearInterval(this.networkPollTimer);
            this.networkPollTimer = undefined;
        }
        if (this.networkPollInFlight) {
            await this.networkPollInFlight;
            this.networkPollInFlight = undefined;
        }
        this.accessPoint.stop();
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    logger.log(LogSeverity.Info, LogArea.Server, "server stopped");
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    private pollNetwork(): void {
        const p = this.networkStatus.getNetworkDetails().then((info) => {
            const prev = this.cachedNetworkInfo;
            this.cachedNetworkInfo = info;

            const hasConnection = info !== undefined && info.IP !== "";
            const hasGateway = hasConnection && info!.Gateway !== "";
            const prevHasConnection = prev !== undefined && prev.IP !== "";
            const prevHasGateway = prevHasConnection && prev!.Gateway !== "";

            const leds = this.sensors.statusLEDs;

            if (!hasConnection && prevHasConnection) {
                // Lost connection
                logger.log(LogSeverity.Severe, LogArea.Server, "network connection lost");
                leds.startErrorFlash("noConnection");
            } else if (hasConnection && !hasGateway && prevHasGateway) {
                // Lost gateway
                logger.log(LogSeverity.Severe, LogArea.Server, "network gateway lost");
                leds.startErrorFlash("noGateway");
            } else if (hasConnection && hasGateway
                && (leds.errorCondition === "noConnection" || leds.errorCondition === "noGateway")) {
                // Recovered from a network error
                logger.log(LogSeverity.Important, LogArea.Server, `network restored: ${info!.ConnectionType} ${info!.IP}`);
                leds.enterNormalMode();
                leds.updatePumpLed(this.sensors.pump.state);
                leds.updateFlowLed(this.sensors.flow.lpm);
                const hot = this.sensors.temperature.findByRole("Hot");
                leds.updateHotLed(hot?.celsius);
            }

            // Log changes
            if (info && prev && (info.IP !== prev.IP || info.ConnectionType !== prev.ConnectionType)) {
                logger.log(LogSeverity.Important, LogArea.Server,
                    `network changed: ${info.ConnectionType} ${info.IP}${info.SSID ? ` (${info.SSID})` : ""}`
                    + ` gw=${info.Gateway || "none"}`
                    + (prev ? ` (was ${prev.ConnectionType} ${prev.IP}${prev.SSID ? ` ${prev.SSID}` : ""} gw=${prev.Gateway || "none"})` : ""));
            } else if (info && !prev) {
                logger.log(LogSeverity.Important, LogArea.Server,
                    `network initial: ${info.ConnectionType} ${info.IP}${info.SSID ? ` (${info.SSID})` : ""} gw=${info.Gateway || "none"}`);
            }

            // Access point management: activate when no usable network for several polls,
            // deactivate once a real connection with gateway is established
            if (!hasConnection || !hasGateway) {
                this.noNetworkCount++;
                logger.log(LogSeverity.Info, LogArea.Server,
                    `no network poll ${this.noNetworkCount}/${FlowHttpServer.AP_ACTIVATE_POLLS} (conn=${hasConnection} gw=${hasGateway} ap=${this.accessPoint.active})`);
                if (this.noNetworkCount >= FlowHttpServer.AP_ACTIVATE_POLLS && !this.accessPoint.active) {
                    logger.log(LogSeverity.Important, LogArea.Server,
                        `no network for ${this.noNetworkCount} polls, starting access point`);
                    this.accessPoint.start(this.listeningPort);
                }
            } else {
                if (this.accessPoint.active) {
                    logger.log(LogSeverity.Important, LogArea.Server,
                        "network available, stopping access point");
                    this.accessPoint.stop();
                }
                this.noNetworkCount = 0;
            }
        }).catch((err) => {
            logger.logError(LogSeverity.Important, LogArea.Server, err as Error, "network poll failed");
        });
        this.networkPollInFlight = p;
    }

    public get address(): { port: number } | undefined {
        const addr = this.server?.address();
        if (addr && typeof addr !== "string") {
            return { port: addr.port };
        }
        return undefined;
    }

    private handleRequest(req: IncomingMessage, res: ServerResponse): void {
        const parsed = new URL(req.url || "/", "http://localhost");
        const path = parsed.pathname;

        logger.log(LogSeverity.Detail, LogArea.Server, `${req.method} ${path}`);

        // Captive portal detection: redirect to WiFi setup page when AP is active.
        // Devices probe known URLs to detect captive portals.
        if (this.accessPoint.active) {
            // Android, Apple, Windows captive portal detection endpoints
            if (path === "/generate_204" || path === "/gen_204"
                || path === "/hotspot-detect.html" || path === "/library/test/success.html"
                || path === "/connecttest.txt" || path === "/ncsi.txt"
                || path === "/redirect") {
                res.writeHead(302, { Location: "/wifi" });
                res.end();
                return;
            }
            // Redirect root to WiFi setup in AP mode
            if (req.method === "GET" && path === "/") {
                res.writeHead(302, { Location: "/wifi" });
                res.end();
                return;
            }
        }

        if (req.method === "PUT" && path === "/pump") {
            this.handlePumpPut(req, res);
            return;
        }

        if (req.method === "POST" && path === "/settings") {
            this.handleSettingsPost(req, res);
            return;
        }

        if (req.method === "POST" && path === "/sensor-setup") {
            this.handleSensorSetupPost(req, res);
            return;
        }

        if (req.method === "POST" && path === "/wifi") {
            this.handleWifiPost(req, res);
            return;
        }

        if (req.method === "POST" && path === "/restart") {
            logger.log(LogSeverity.Important, LogArea.General, "restart requested via dashboard");
            this.sendJson(res, 200, { status: "restarting" });
            // Delay exit to allow the response to be sent
            setTimeout(() => {
                this.sensors.stop();
                process.exit(0);
            }, 500);
            return;
        }

        if (req.method !== "GET") {
            this.sendJson(res, 405, { error: "method not allowed" });
            return;
        }

        switch (path) {
            case "/":
                if (this.sensors.temperature.needsSensorSetup()) {
                    res.writeHead(302, { Location: "/sensor-setup" });
                    res.end();
                } else {
                    this.sendDashboard(res);
                }
                break;

            case "/api/cards":
                this.sendDashboardCards(res);
                break;

            case "/api/log": {
                const logText = logger.fullLog(LogSeverity.Detail);
                this.sendText(res, logText);
                break;
            }

            case "/status":
                this.sendJson(res, 200, this.sensors.getStatus());
                break;

            case "/temperature": {
                const sensorParam = parsed.searchParams.get("sensor");
                if (sensorParam !== null) {
                    const sensorIndex = parseInt(sensorParam as string, 10);
                    if (isNaN(sensorIndex)) {
                        this.sendJson(res, 400, { error: "sensor parameter must be an integer" });
                        return;
                    }
                    const temp = this.sensors.getTemperature(sensorIndex);
                    if (temp.sensors.length === 0) {
                        this.sendJson(res, 404, { error: `sensor ${sensorIndex} not found` });
                        return;
                    }
                    this.sendJson(res, 200, temp);
                } else {
                    this.sendJson(res, 200, this.sensors.getTemperature());
                }
                break;
            }

            case "/flow":
                this.sendJson(res, 200, this.sensors.getFlow());
                break;

            case "/pump":
                this.sendJson(res, 200, this.sensors.getPump());
                break;

            case "/log":
                this.sendHtml(res, buildLogHtml());
                break;

            case "/settings":
                this.sendHtml(res, buildSettingsHtml());
                break;

            case "/sensor-setup":
                this.sendSensorSetupPage(res);
                break;

            case "/wifi":
                this.handleWifiGet(res, req);
                break;

            case "/wifi/scan":
                this.handleWifiScan(res);
                break;

            case "/calendar": {
                const dateParam = parsed.searchParams.get("date") ?? undefined;
                const viewParam = parsed.searchParams.get("view") ?? undefined;
                const todayStr = dateString();
                const allDays = this.sensors.historyStore.getAllDays();
                const oldestDate = allDays.length > 0 ? allDays[0].date : todayStr;
                const latestDate = todayStr;
                // Clamp requested date to valid range
                let requestDate = dateParam || todayStr;
                if (requestDate > latestDate) { requestDate = latestDate; }
                if (requestDate < oldestDate) { requestDate = oldestDate; }

                if (viewParam === "month") {
                    const todaySummary = this.sensors.statsAccumulator.toSummary();
                    this.sendHtml(res, buildCalendarMonthHtml(allDays, todaySummary, requestDate, oldestDate, latestDate));
                } else if (viewParam === "week") {
                    const todaySummary = this.sensors.statsAccumulator.toSummary();
                    this.sendHtml(res, buildCalendarWeekHtml(allDays, todaySummary, requestDate, oldestDate, latestDate));
                } else {
                    const isToday = requestDate === todayStr;
                    const daySummary = isToday
                        ? this.sensors.statsAccumulator.toSummary()
                        : this.sensors.historyStore.getDay(requestDate);
                    const timeline = isToday
                        ? this.sensors.statsAccumulator.timeline
                        : (daySummary?.timeline
                            ? DayTimeline.fromSparse(requestDate, daySummary.timeline)
                            : new DayTimeline(requestDate));
                    this.sendHtml(res, buildCalendarDayHtml(timeline, requestDate, isToday, oldestDate, latestDate, daySummary));
                }
                break;
            }

            default:
                this.sendJson(res, 404, { error: "not found" });
                break;
        }
    }

    private handlePumpPut(req: IncomingMessage, res: ServerResponse): void {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
            try {
                const data = JSON.parse(body);
                if (typeof data.state !== "boolean") {
                    this.sendJson(res, 400, { error: "state must be a boolean" });
                    return;
                }
                const result = this.sensors.setPump(data.state);
                this.sendJson(res, 200, result);
            } catch (e) {
                this.sendJson(res, 400, { error: "invalid JSON" });
            }
        });
    }

    private sendDashboard(res: ServerResponse): void {
        const status = this.sensors.getStatus();
        const stats = this.sensors.getStatsSnapshot();
        const html = buildDashboardHtml(status, stats, this.sensors.statusLEDs.mode,
            this.homekit?.qrCodeSvg, this.homekit?.setupURI, this.cachedNetworkInfo,
            this.sensors.statusLEDs.errorCondition);
        this.sendHtml(res, html);
    }

    private sendDashboardCards(res: ServerResponse): void {
        const status = this.sensors.getStatus();
        const stats = this.sensors.getStatsSnapshot();
        const html = buildDashboardCards(status, stats, this.sensors.statusLEDs.mode,
            this.homekit?.qrCodeSvg, this.sensors.statusLEDs.errorCondition);
        this.sendHtml(res, html);
    }

    private handleSettingsPost(req: IncomingMessage, res: ServerResponse): void {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
            const params = new URLSearchParams(body);
            const updates: Partial<FlowConfig> = {};

            const pumpMax = parseInt(params.get("pumpMaxRunTime") || "", 10);
            if (!isNaN(pumpMax) && pumpMax >= 1) { updates.pumpMaxRunTime = pumpMax; }

            const flowStart = parseInt(params.get("flowStartDelay") || "", 10);
            if (!isNaN(flowStart) && flowStart >= 1) { updates.flowStartDelay = flowStart; }

            const flowStop = parseInt(params.get("flowStopDelay") || "", 10);
            if (!isNaN(flowStop) && flowStop >= 1) { updates.flowStopDelay = flowStop; }

            const pumpWatts = parseInt(params.get("pumpWatts") || "", 10);
            if (!isNaN(pumpWatts) && pumpWatts >= 0) { updates.pumpWatts = pumpWatts; }

            const heaterWatts = parseInt(params.get("heaterWatts") || "", 10);
            if (!isNaN(heaterWatts) && heaterWatts >= 0) { updates.heaterWatts = heaterWatts; }

            const heaterTemp = parseInt(params.get("heaterTempSetting") || "", 10);
            if (!isNaN(heaterTemp) && heaterTemp >= 0) {
                // Config stores Celsius; convert if user is in Fahrenheit
                updates.heaterTempSetting = TEMP_UNITS === "F" ? Math.round(fToC(heaterTemp)) : heaterTemp;
            }

            const energyCostRate = parseFloat(params.get("energyCostRate") || "");
            if (!isNaN(energyCostRate) && energyCostRate >= 0) { updates.energyCostRate = energyCostRate; }

            const energyCostCurrency = params.get("energyCostCurrency");
            if (energyCostCurrency === "$" || energyCostCurrency === "€" || energyCostCurrency === "¥") {
                updates.energyCostCurrency = energyCostCurrency;
            }

            const waterCostRate = parseFloat(params.get("waterCostRate") || "");
            if (!isNaN(waterCostRate) && waterCostRate >= 0) { updates.waterCostRate = waterCostRate; }

            const locale = params.get("locale");
            if (locale) { updates.locale = locale; }

            const tempUnits = params.get("tempUnits");
            if (tempUnits === "C" || tempUnits === "F") { updates.tempUnits = tempUnits; }

            const flowUnits = params.get("flowUnits");
            if (flowUnits === "L" || flowUnits === "G") { updates.flowUnits = flowUnits; }

            const doorEnabled = params.get("doorMonitorEnabled");
            if (doorEnabled !== null) {
                const wasEnabled = DOOR_MONITOR_ENABLED;
                updates.doorMonitorEnabled = doorEnabled === "1";
                // Start/stop monitor if the setting changed
                if (updates.doorMonitorEnabled && !wasEnabled) {
                    // Will start after applyConfig sets the global
                } else if (!updates.doorMonitorEnabled && wasEnabled) {
                    this.sensors.doorMonitor.stop();
                }
            }

            const doorNames: Record<string, string> = {};
            for (const i of [1, 2]) {
                const name = params.get(`doorName${i}`)?.trim();
                if (name) { doorNames[String(i)] = name; }
            }
            updates.doorNames = doorNames;

            saveConfig(updates);
            applyConfig(updates);

            // Start door monitor if it was just enabled
            if (doorEnabled === "1" && !this.sensors.doorMonitor.isRunning) {
                this.sensors.doorMonitor.start();
            }

            logger.log(LogSeverity.Info, LogArea.Server, "settings updated");

            this.sendHtml(res, buildSettingsHtml(true));
        });
    }

    private sendSensorSetupPage(res: ServerResponse, saved?: boolean, error?: string): void {
        const allSensors = this.sensors.temperature.getAllSensors().map((s) => ({
            deviceId: s.deviceId,
            name: s.name,
            celsius: s.celsius,
        }));
        const missing = this.sensors.temperature.getMissingSensors();
        this.sendHtml(res, buildSensorSetupHtml(allSensors, missing, saved, error));
    }

    private handleSensorSetupPost(req: IncomingMessage, res: ServerResponse): void {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
            const params = new URLSearchParams(body);
            const newSensors: SensorNameConfig = {};
            let hasHot = false;
            const usedRoles = new Set<string>();
            let duplicateError = false;

            for (const sensor of this.sensors.temperature.getAllSensors()) {
                if (!sensor.deviceId) { continue; }
                const role = params.get(`role_${sensor.deviceId}`) || "";
                if (role && VALID_SENSOR_ROLES.includes(role as SensorRole)) {
                    if (usedRoles.has(role)) {
                        duplicateError = true;
                    }
                    usedRoles.add(role);
                    newSensors[sensor.deviceId] = role;
                    if (role === "Hot") { hasHot = true; }
                }
            }

            if (duplicateError) {
                this.sendSensorSetupPage(res, false, L("sensorRoleDuplicate"));
                return;
            }

            if (!hasHot && this.sensors.temperature.sensorCount > 0) {
                this.sendSensorSetupPage(res, false, L("sensorRoleRequired"));
                return;
            }

            saveSensorConfig({ sensors: newSensors });
            this.sensors.temperature.renameSensors();
            this.homekit?.updateSensorNames();
            logger.log(LogSeverity.Info, LogArea.Temperature, "sensor config updated");
            this.sendSensorSetupPage(res, true);
        });
    }

    private triggerWifiRescan(): void {
        if (!IS_LINUX) { return; }
        try {
            execSync("nmcli device wifi rescan", { timeout: 5000, stdio: "pipe" });
        } catch { /* rescan may fail if one is already in progress — ignore */ }
    }

    /** Ensure the currently connected SSID always appears in the network list. */
    private ensureCurrentInList(networks: WifiNetwork[], currentSSID?: string): WifiNetwork[] {
        if (!currentSSID) { return networks; }
        if (networks.some((n) => n.ssid === currentSSID)) { return networks; }
        // Insert the connected network (always known since it has a profile)
        const connected: WifiNetwork = { ssid: currentSSID, quality: 100, security: ["WPA2"], known: true };
        return [...networks, connected];
    }

    private handleWifiGet(res: ServerResponse, req?: IncomingMessage): void {
        const apMode = this.accessPoint.active;
        const ethPresent = hasEthernetConnection();
        const clientVia = req ? getClientInterface(req.socket.localAddress) : undefined;
        if (!IS_LINUX) {
            this.sendHtml(res, buildWifiHtml([], undefined,
                { text: L("wifiNotAvailable"), success: false }, apMode, this.cachedNetworkInfo, this.wifiDisabled, ethPresent, clientVia));
            return;
        }
        if (this.wifiDisabled) {
            this.sendHtml(res, buildWifiHtml([], undefined, undefined, apMode,
                this.cachedNetworkInfo, true, ethPresent, clientVia));
            return;
        }
        this.triggerWifiRescan();
        scanWifiNetworks().then((networks) => {
            const currentSSID = this.cachedNetworkInfo?.SSID;
            const tagged = tagKnownNetworks(this.ensureCurrentInList(networks, currentSSID));
            this.sendHtml(res, buildWifiHtml(tagged, currentSSID, undefined, apMode,
                this.cachedNetworkInfo, false, ethPresent, clientVia));
        }).catch((err) => {
            logger.logError(LogSeverity.Important, LogArea.Server, err as Error, "wifi scan failed");
            this.sendHtml(res, buildWifiHtml([], undefined,
                { text: (err as Error).message, success: false }, apMode, this.cachedNetworkInfo, false, ethPresent, clientVia));
        });
    }

    private handleWifiScan(res: ServerResponse): void {
        if (!IS_LINUX) {
            this.sendJson(res, 200, { networks: [], currentSSID: null, networkInfo: null });
            return;
        }
        this.triggerWifiRescan();
        scanWifiNetworks().then((networks) => {
            const currentSSID = this.cachedNetworkInfo?.SSID || null;
            const tagged = tagKnownNetworks(this.ensureCurrentInList(networks, currentSSID || undefined));
            this.sendJson(res, 200, {
                networks: tagged,
                currentSSID,
                networkInfo: this.cachedNetworkInfo || null,
            });
        }).catch((err) => {
            logger.logError(LogSeverity.Important, LogArea.Server, err as Error, "wifi scan failed");
            this.sendJson(res, 200, { networks: [], currentSSID: null, networkInfo: null });
        });
    }

    private handleWifiPost(req: IncomingMessage, res: ServerResponse): void {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
            const params = new URLSearchParams(body);
            const action = params.get("action") || "";

            if (action === "disconnect") {
                this.handleWifiDisconnect(res);
                return;
            }

            if (action === "disable_wifi") {
                this.handleWifiToggle(res, false);
                return;
            }

            if (action === "enable_wifi") {
                this.handleWifiToggle(res, true);
                return;
            }

            const ssid = params.get("ssid") || "";
            // For reconnect, use saved password; otherwise use provided password
            let password = params.get("password") || "";
            if (action === "reconnect" && !password) {
                password = wifiPasswords.get(ssid) || "";
            }

            const wantsJson = (req.headers.accept || "").includes("application/json");

            if (!ssid) {
                if (wantsJson) {
                    this.sendJson(res, 400, { success: false, message: "No SSID specified" });
                } else {
                    this.handleWifiGet(res);
                }
                return;
            }

            const previousSSID = this.cachedNetworkInfo?.SSID;
            const wasApMode = this.accessPoint.active;
            logger.log(LogSeverity.Important, LogArea.Server,
                `wifi: attempting connection to "${ssid}" (previous: "${previousSSID || "none"}"${wasApMode ? ", AP mode" : ""})`);

            // Stop the AP before connecting — the radio can only do one thing at a time
            if (wasApMode) {
                this.accessPoint.stop();
            }

            const result = connectToWifi(ssid, password);

            if (result.success) {
                logger.log(LogSeverity.Important, LogArea.Server, `wifi: connected to "${ssid}"`);
                // Save password for future reconnect
                if (password) {
                    try {
                        wifiPasswords.set(ssid, password);
                        logger.log(LogSeverity.Info, LogArea.Server, `wifi: saved password for "${ssid}"`);
                    } catch (e) {
                        logger.logError(LogSeverity.Important, LogArea.Server, e as Error, "wifi: failed to save password");
                    }
                }
                // Refresh network info immediately
                this.pollNetwork();
                if (wantsJson) {
                    this.sendJson(res, 200, { success: true, message: L("wifiSuccess") });
                } else {
                    scanWifiNetworks().then((networks) => {
                        const tagged = tagKnownNetworks(this.ensureCurrentInList(networks, ssid));
                        this.sendHtml(res, buildWifiHtml(tagged, ssid,
                            { text: L("wifiSuccess"), success: true }, false, this.cachedNetworkInfo));
                    }).catch(() => {
                        this.sendHtml(res, buildWifiHtml([], ssid,
                            { text: L("wifiSuccess"), success: true }, false, this.cachedNetworkInfo));
                    });
                }
            } else {
                logger.log(LogSeverity.Severe, LogArea.Server,
                    `wifi: failed to connect to "${ssid}": ${result.error}`);

                // Attempt to reconnect to previous network
                let message: string;
                if (previousSSID && previousSSID !== ssid) {
                    const reconnected = reconnectToWifi(previousSSID);
                    if (reconnected) {
                        logger.log(LogSeverity.Important, LogArea.Server,
                            `wifi: reconnected to previous network "${previousSSID}"`);
                        this.pollNetwork();
                    }
                    message = L("wifiFailReconnect");
                } else if (wasApMode) {
                    // No previous WiFi to reconnect to — restart the AP
                    logger.log(LogSeverity.Important, LogArea.Server,
                        "wifi: connection failed in AP mode, restarting access point");
                    this.accessPoint.start(this.listeningPort);
                    message = L("wifiFailNoFallback");
                } else {
                    message = L("wifiFailNoFallback");
                }

                if (wantsJson) {
                    this.sendJson(res, 200, { success: false, message });
                } else {
                    scanWifiNetworks().then((networks) => {
                        const tagged = tagKnownNetworks(this.ensureCurrentInList(networks, previousSSID));
                        this.sendHtml(res, buildWifiHtml(tagged, previousSSID,
                            { text: message, success: false }, false, this.cachedNetworkInfo));
                    }).catch(() => {
                        this.sendHtml(res, buildWifiHtml([], previousSSID,
                            { text: message, success: false }, false, this.cachedNetworkInfo));
                    });
                }
            }
        });
    }

    private handleWifiDisconnect(res: ServerResponse): void {
        const currentSSID = this.cachedNetworkInfo?.SSID;
        const apMode = this.accessPoint.active;
        if (currentSSID) {
            logger.log(LogSeverity.Important, LogArea.Server, `wifi: disconnecting from "${currentSSID}"`);
            try {
                // Disconnect from the current WiFi without disabling the interface
                execSync(`nmcli device disconnect ${AP_INTERFACE}`,
                    { timeout: 10000, stdio: "pipe" });
                logger.log(LogSeverity.Important, LogArea.Server, "wifi: disconnected");
            } catch (e) {
                logger.logError(LogSeverity.Important, LogArea.Server, e as Error, "wifi disconnect failed");
            }
        }
        // Refresh network info immediately
        this.pollNetwork();
        scanWifiNetworks().then((networks) => {
            const tagged = tagKnownNetworks(networks);
            this.sendHtml(res, buildWifiHtml(tagged, undefined,
                { text: L("wifiDisconnected"), success: true }, apMode, this.cachedNetworkInfo));
        }).catch(() => {
            this.sendHtml(res, buildWifiHtml([], undefined,
                { text: L("wifiDisconnected"), success: true }, apMode, this.cachedNetworkInfo));
        });
    }

    private handleWifiToggle(res: ServerResponse, enable: boolean): void {
        if (enable) {
            this.wifiDisabled = false;
            logger.log(LogSeverity.Important, LogArea.Server, "wifi: turned on");
        } else {
            // Disconnect WiFi before disabling
            const currentSSID = this.cachedNetworkInfo?.SSID;
            if (currentSSID) {
                try {
                    execSync(`nmcli device disconnect ${AP_INTERFACE}`,
                        { timeout: 10000, stdio: "pipe" });
                    logger.log(LogSeverity.Important, LogArea.Server,
                        `wifi: disconnected from "${currentSSID}" (turning off)`);
                } catch (e) {
                    logger.logError(LogSeverity.Important, LogArea.Server, e as Error, "wifi disconnect failed");
                }
            }
            this.wifiDisabled = true;
            logger.log(LogSeverity.Important, LogArea.Server, "wifi: turned off");
        }
        // Refresh network info before rendering so the card shows the current state
        this.networkStatus.getNetworkDetails().then((info) => {
            this.cachedNetworkInfo = info;
            this.handleWifiGet(res);
        }).catch(() => {
            this.handleWifiGet(res);
        });
    }

    private sendHtml(res: ServerResponse, html: string): void {
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": Buffer.byteLength(html),
        });
        res.end(html);
    }

    private sendText(res: ServerResponse, text: string): void {
        res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": Buffer.byteLength(text),
        });
        res.end(text);
    }

    private sendJson(res: ServerResponse, status: number, body: object): void {
        const json = JSON.stringify(body);
        res.writeHead(status, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(json),
        });
        res.end(json);
    }
}

// ---- Loopback Test ----

interface LoopbackResult {
    sent: number;
    received: number;
    periods: number[];
    flows: number[];
    passed: boolean;
    error?: string;
}

async function runLoopbackTest(): Promise<LoopbackResult> {
    if (!IS_LINUX) {
        return { sent: 0, received: 0, periods: [], flows: [], passed: false, error: "loopback test requires GPIO (Linux only)" };
    }

    const testFrequencies = [10, 5, 2];    // Hz — simulating different flow rates
    const pulsesPerFreq = 6;
    const result: LoopbackResult = { sent: 0, received: 0, periods: [], flows: [], passed: false };

    // Start monitoring input pin for edges
    let lastEdgeTime = 0;
    const monProc = spawn("gpiomon", [
        "--chip", "0", "--edges", "both", "--format", "%e", String(LOOPBACK_IN_PIN)
    ]);

    monProc.stdout?.on("data", (data: Buffer) => {
        const lines = data.toString().trim().split("\n");
        for (const _line of lines) {
            const now = Date.now();
            if (lastEdgeTime > 0) {
                const pw = now - lastEdgeTime;
                result.periods.push(pw);
                result.flows.push(pwToFlow(pw));
                result.received++;
            }
            lastEdgeTime = now;
        }
    });

    // Wait for gpiomon to start
    await sleep(200);

    logger.log(LogSeverity.Important, LogArea.GPIO,
        `loopback test: output BCM ${LOOPBACK_OUT_PIN} (pin 18) → input BCM ${LOOPBACK_IN_PIN} (pin 16)`);
    logger.log(LogSeverity.Important, LogArea.GPIO,
        `testing ${testFrequencies.length} frequencies: ${testFrequencies.map(f => f + " Hz").join(", ")}`);

    // Generate square wave at each frequency
    let outProc: ChildProcess | undefined;
    for (const freq of testFrequencies) {
        const halfPeriod = Math.round(500 / freq); // ms per half-cycle
        logger.log(LogSeverity.Info, LogArea.GPIO, `generating ${freq} Hz (${halfPeriod}ms half-period)`);

        for (let i = 0; i < pulsesPerFreq * 2; i++) {
            const value = i % 2 === 0 ? 1 : 0;
            if (outProc) {
                outProc.kill("SIGKILL");
                outProc = undefined;
            }
            outProc = spawn("gpioset", ["--chip", "0", `${LOOPBACK_OUT_PIN}=${value}`]);
            result.sent++;
            await sleep(halfPeriod);
        }

        // Pause between frequencies
        await sleep(200);
    }

    // Wait for final edges to settle
    await sleep(100);

    // Clean up
    if (outProc) {
        outProc.kill("SIGKILL");
    }
    monProc.kill();

    // Evaluate results
    const totalEdges = testFrequencies.length * pulsesPerFreq * 2;
    const minExpected = Math.floor(totalEdges * 0.7); // allow 30% missed edges
    result.passed = result.received >= minExpected;

    logger.log(LogSeverity.Important, LogArea.GPIO,
        `loopback result: ${result.received} edges received of ${totalEdges} sent — ${result.passed ? "PASS" : "FAIL"}`);

    if (result.flows.length > 0) {
        const avgFlow = result.flows.reduce((a, b) => a + b, 0) / result.flows.length;
        logger.log(LogSeverity.Info, LogArea.GPIO,
            `average computed flow: ${avgFlow.toFixed(2)} L/min (from test signal, not real flow)`);
    }

    return result;
}

// ---- HomeKit Bridge ----

class HomeKitBridge {
    private readonly bridge: Bridge;
    private readonly sensors: SensorManager;
    private _setupURI: string | undefined;
    private _qrCodeSvg: string | undefined;
    // Map sensor index → accessory, so names can be updated after sensor setup
    private readonly tempAccessories = new Map<number, Accessory>();

    constructor(sensors: SensorManager) {
        this.sensors = sensors;
        const bridgeUuid = uuid.generate("oyu:bridge");
        this.bridge = new Bridge("Hot Water System", bridgeUuid);

        this.addTemperatureSensors();
        this.addFlowSensor();
        this.addPumpSwitch();
        this.addServerStatus();
        this.addDoorSensors();
    }

    /** Update HomeKit accessory names to match current sensor names. */
    public updateSensorNames(): void {
        for (const sensor of this.sensors.temperature.getAllSensors()) {
            const acc = this.tempAccessories.get(sensor.index);
            if (!acc) { continue; }
            const newName = `${sensor.name} Temperature`;
            if (acc.displayName !== newName) {
                acc.displayName = newName;
                acc.getService(Service.AccessoryInformation)
                    ?.updateCharacteristic(Characteristic.Name, newName);
                acc.getService(Service.TemperatureSensor)
                    ?.updateCharacteristic(Characteristic.Name, newName);
                logger.log(LogSeverity.Info, LogArea.General,
                    `HomeKit: renamed temperature sensor to "${newName}"`);
            }
        }
    }

    private addTemperatureSensors(): void {
        for (const sensor of this.sensors.temperature.getAllSensors()) {
            // Use deviceId or index for stable UUID so renaming doesn't create a new accessory
            const stableId = sensor.deviceId || String(sensor.index);
            const accUuid = uuid.generate(`oyu:temp:${stableId}`);
            const acc = new Accessory(`${sensor.name} Temperature`, accUuid);
            acc.category = Categories.SENSOR;

            const svc = acc.addService(Service.TemperatureSensor);
            svc.getCharacteristic(Characteristic.CurrentTemperature)
                .onGet(() => sensor.celsius ?? 0);

            // Push updates when temperature changes
            const origCb = sensor.onSignificantChange;
            sensor.onSignificantChange = (name, oldC, newC) => {
                if (origCb) { origCb(name, oldC, newC); }
                svc.updateCharacteristic(Characteristic.CurrentTemperature, newC);
            };

            this.tempAccessories.set(sensor.index, acc);
            this.bridge.addBridgedAccessory(acc);
            logger.log(LogSeverity.Info, LogArea.General, `HomeKit: added temperature sensor "${sensor.name}"`);
        }
    }

    private addFlowSensor(): void {
        const accUuid = uuid.generate("oyu:flow");
        const acc = new Accessory("Water Flow", accUuid);
        acc.category = Categories.SENSOR;

        const svc = acc.addService(Service.ContactSensor);
        svc.getCharacteristic(Characteristic.ContactSensorState)
            .onGet(() => this.sensors.flow.lpm > 0
                ? Characteristic.ContactSensorState.CONTACT_DETECTED
                : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

        // Push updates when flow starts/stops
        const origCb = this.sensors.flow.onFlowChange;
        this.sensors.flow.onFlowChange = (started, lpm) => {
            if (origCb) { origCb(started, lpm); }
            svc.updateCharacteristic(Characteristic.ContactSensorState,
                lpm > 0
                    ? Characteristic.ContactSensorState.CONTACT_DETECTED
                    : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
        };

        this.bridge.addBridgedAccessory(acc);
        logger.log(LogSeverity.Info, LogArea.General, "HomeKit: added flow sensor");
    }

    private addPumpSwitch(): void {
        const accUuid = uuid.generate("oyu:pump");
        const acc = new Accessory("Hot Water Pump", accUuid);
        acc.category = Categories.SWITCH;

        const switchService = acc.addService(Service.Switch);

        switchService.getCharacteristic(Characteristic.On)
            .onGet(() => this.sensors.pump.state)
            .onSet((value: CharacteristicValue) => {
                this.sensors.setPump(value as boolean);
            });

        // Push state changes to HomeKit when pump changes outside of HomeKit
        this.sensors.pump.onStateChange = ((original) => {
            return (on: boolean, source: PumpSource) => {
                if (original) { original(on, source); }
                switchService.updateCharacteristic(Characteristic.On, on);
            };
        })(this.sensors.pump.onStateChange);

        this.bridge.addBridgedAccessory(acc);
        logger.log(LogSeverity.Info, LogArea.General, "HomeKit: added pump switch");
    }

    private addServerStatus(): void {
        const accUuid = uuid.generate("oyu:status");
        const acc = new Accessory("Server Status", accUuid);
        acc.category = Categories.SENSOR;

        acc.addService(Service.ContactSensor)
            .getCharacteristic(Characteristic.ContactSensorState)
            .onGet(() => this.sensors.statusLEDs.mode === "error"
                ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
                : Characteristic.ContactSensorState.CONTACT_DETECTED);

        this.bridge.addBridgedAccessory(acc);
        logger.log(LogSeverity.Info, LogArea.General, "HomeKit: added server status sensor");
    }

    private addDoorSensors(): void {
        if (!DOOR_MONITOR_ENABLED) { return; }

        // Track last known open/closed state per door ID for HomeKit status
        const doorOpen = new Map<number, boolean>();
        // Collect services keyed by door ID so a single onEvent callback can dispatch
        const doorServices = new Map<number, InstanceType<typeof Service.ContactSensor>>();

        for (const [idStr, name] of Object.entries(DOOR_NAMES)) {
            if (!name) { continue; }
            const doorId = parseInt(idStr, 10);

            const accUuid = uuid.generate(`oyu:door:${doorId}`);
            const acc = new Accessory(name, accUuid);
            acc.category = Categories.SENSOR;

            const svc = acc.addService(Service.ContactSensor);
            svc.getCharacteristic(Characteristic.ContactSensorState)
                .onGet(() => doorOpen.get(doorId)
                    ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED   // open
                    : Characteristic.ContactSensorState.CONTACT_DETECTED);     // closed

            doorServices.set(doorId, svc);
            this.bridge.addBridgedAccessory(acc);
            logger.log(LogSeverity.Info, LogArea.General, `HomeKit: added door sensor "${name}" (ID ${doorId})`);
        }

        if (doorServices.size === 0) { return; }

        // Single onEvent callback that dispatches to the right HomeKit service
        const origCb = this.sensors.doorMonitor.onEvent;
        this.sensors.doorMonitor.onEvent = (event: DoorEvent) => {
            if (origCb) { origCb(event); }
            const svc = doorServices.get(event.doorId);
            if (!svc) { return; }
            const isOpen = event.type === "open" && event.openSeconds === DOOR_STILL_OPEN_SENTINEL;
            doorOpen.set(event.doorId, isOpen);
            svc.updateCharacteristic(Characteristic.ContactSensorState,
                isOpen
                    ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
                    : Characteristic.ContactSensorState.CONTACT_DETECTED);
        };
    }

    public get setupURI(): string | undefined {
        return this._setupURI;
    }

    public get qrCodeSvg(): string | undefined {
        return this._qrCodeSvg;
    }

    public async start(): Promise<void> {
        await this.bridge.publish({
            username: HOMEKIT_USERNAME,
            pincode: HOMEKIT_PIN,
            port: HOMEKIT_PORT,
            category: Categories.BRIDGE,
        });
        this._setupURI = this.bridge.setupURI();
        try {
            this._qrCodeSvg = await QRCode.toString(this._setupURI, {
                type: "svg",
                margin: 1,
                width: 200,
                color: { dark: "#e2e8f0", light: "#0f172a" },
            });
        } catch (e) {
            logger.logError(LogSeverity.Important, LogArea.General, e as Error, "failed to generate HomeKit QR code");
        }
        logger.log(LogSeverity.Important, LogArea.General,
            `HomeKit bridge published on port ${HOMEKIT_PORT}, pin: ${HOMEKIT_PIN}, URI: ${this._setupURI}`);
    }

    public async stop(): Promise<void> {
        await this.bridge.unpublish();
        logger.log(LogSeverity.Info, LogArea.General, "HomeKit bridge unpublished");
    }
}

// ---- CLI ----

interface CliOptions {
    command: "version" | "help" | "temperature" | "flow" | "serve" | "looptest" | "pump";
    port: number;
    sensor: number | undefined;
    pumpState: boolean | undefined;
}

function parseArgs(args: string[]): CliOptions {
    const opts: CliOptions = {
        command: "serve",
        port: DEFAULT_PORT,
        sensor: undefined,
        pumpState: undefined,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "-v":
            case "--version":
                opts.command = "version";
                break;
            case "-h":
            case "--help":
                opts.command = "help";
                break;
            case "-t":
            case "--temperature":
                opts.command = "temperature";
                if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
                    i++;
                    opts.sensor = parseInt(args[i], 10);
                }
                break;
            case "-f":
            case "--flow":
                opts.command = "flow";
                break;
            case "-l":
            case "--looptest":
                opts.command = "looptest";
                break;
            case "-p":
            case "--pump":
                opts.command = "pump";
                if (i + 1 < args.length && (args[i + 1] === "0" || args[i + 1] === "1")) {
                    i++;
                    opts.pumpState = args[i] === "1";
                }
                break;
            case "-s":
            case "--serve":
                opts.command = "serve";
                if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
                    i++;
                    opts.port = parseInt(args[i], 10);
                }
                break;
        }
    }

    return opts;
}

function printHelp(): void {
    console.log(`flow_server v${VERSION} - Raspberry Pi sensor HTTP server

Usage: node flow_server.js [options]

Options:
  -v, --version          Print version and exit
  -h, --help             Print this help and exit
  -t, --temperature [N]  Read temperature sensor N, or all if N omitted
  -f, --flow             Read flow sensor and exit
  -p, --pump [0|1]       Get pump state, or set to off (0) or on (1)
  -l, --looptest         GPIO loopback test (jumper BCM 24 → BCM 23)
  -s, --serve [port]     Start HTTP server (default port ${DEFAULT_PORT})

Endpoints:
  GET  /status               Overall status with all sensor readings
  GET  /temperature          All temperature sensor readings
  GET  /temperature?sensor=N Temperature reading from sensor N
  GET  /flow                 Current flow reading
  GET  /pump                 Current pump state
  PUT  /pump                 Set pump state (body: {"state": true|false})
`);
}

// ---- Main ----

async function main(args: string[]): Promise<void> {
    const cfg = loadConfig();
    if (cfg) {
        applyConfig(cfg);
        logger.log(LogSeverity.Important, LogArea.General, `loaded config from ${CONFIG_FILE}`);
    }

    const opts = parseArgs(args);

    switch (opts.command) {
        case "version":
            console.log(`flow_server v${VERSION}`);
            return;

        case "help":
            printHelp();
            return;

        case "temperature": {
            const sensors = new SensorManager();
            sensors.temperature.start();
            await sleep(SECOND);
            const reading = sensors.getTemperature(opts.sensor);
            sensors.stop();
            if (reading.sensors.length === 0) {
                console.log(opts.sensor !== undefined ? `Sensor ${opts.sensor}: not found` : "No temperature sensors found");
            } else {
                for (const s of reading.sensors) {
                    console.log(`${s.name}: ${formatTemp(s.celsius)}`);
                }
            }
            return;
        }

        case "flow": {
            const sensors = new SensorManager();
            sensors.flow.start();
            await sleep(2 * SECOND);
            const reading = sensors.getFlow();
            sensors.stop();
            console.log(`Flow: ${formatFlow(reading.lpm)}`);
            return;
        }

        case "pump": {
            const sensors = new SensorManager();
            if (opts.pumpState !== undefined) {
                const result = sensors.setPump(opts.pumpState);
                console.log(`Pump: ${result.state ? "ON" : "OFF"}`);
            } else {
                const result = sensors.getPump();
                const pumpAgo = result.timeSinceLastChange >= 0 ? ` (since ${formatDuration(result.timeSinceLastChange)} ago)` : "";
                console.log(`Pump: ${result.state ? "ON" : "OFF"}${pumpAgo}`);
            }
            return;
        }

        case "looptest": {
            console.log("GPIO loopback test: jumper BCM 24 (pin 18) → BCM 23 (pin 16)");
            const result = await runLoopbackTest();
            console.log(`Result: ${result.passed ? "PASS" : "FAIL"} — ${result.received} edges received`);
            if (result.error) {
                console.log(`Error: ${result.error}`);
            }
            if (result.periods.length > 0) {
                console.log(`Periods (ms): ${result.periods.map(p => p.toFixed(0)).join(", ")}`);
            }
            process.exit(result.passed ? 0 : 1);
        }

        case "serve": {
            // Check for stale gpioset/gpioget processes that would block GPIO access
            if (IS_LINUX) {
                try {
                    const ps = execSync("ps -eo pid,comm", { timeout: 5000, stdio: "pipe" }).toString();
                    const stale = ps.split("\n").filter((line) =>
                        /\bgpioset\b/.test(line) || /\bgpioget\b/.test(line));
                    if (stale.length > 0) {
                        console.error("ERROR: Found stale GPIO processes that will prevent LED/sensor access:");
                        for (const line of stale) {
                            console.error(`  ${line.trim()}`);
                        }
                        console.error("Kill these processes (e.g. sudo killall gpioset gpioget) and restart.");
                        process.exit(1);
                    }
                } catch { /* ps failed — continue anyway */ }
            }

            // Log startup with system info for post-mortem diagnostics
            const sysUptimeSec = Math.round(osUptime());
            const sysUptimeStr = sysUptimeSec < 120
                ? `${sysUptimeSec}s (likely just rebooted)`
                : formatDuration(sysUptimeSec * 1000);
            const mem = process.memoryUsage();
            logger.log(LogSeverity.Important, LogArea.General,
                `starting v${VERSION} — node ${process.version} pid ${process.pid}`
                + ` — system uptime ${sysUptimeStr}`
                + ` — mem RSS ${(mem.rss / 1048576).toFixed(0)}MB heap ${(mem.heapUsed / 1048576).toFixed(0)}/${(mem.heapTotal / 1048576).toFixed(0)}MB`
                + ` — system ${(freemem() / 1048576).toFixed(0)}/${(totalmem() / 1048576).toFixed(0)}MB free`);

            // Clean up any stale AP profile from a previous crash
            const startupAp = new AccessPoint();
            startupAp.cleanup();

            const sensors = new SensorManager();
            const leds = sensors.statusLEDs;

            // Start LED cycling animation during startup checks
            leds.startCycling();

            const errors: string[] = [];
            let loopbackFailed = false;
            let temperatureFailed = false;

            // Run loopback self-test on startup (jumper must be connected)
            if (IS_LINUX) {
                const loopback = await runLoopbackTest();
                logger.log(LogSeverity.Important, LogArea.GPIO,
                    `startup loopback: ${loopback.passed ? "PASS" : "FAIL"} (${loopback.received} edges)`);
                if (!loopback.passed) {
                    loopbackFailed = true;
                    errors.push(`loopback test failed (${loopback.received} edges, ${loopback.error || "insufficient edges"})`);
                }
            }

            // Start sensors so we can check gpiomon and temperature count
            sensors.start();
            logger.log(LogSeverity.Important, LogArea.General, `log file: ${sensors.activityLogger.logPath}`);

            // Check gpiomon started OK
            const gpioErr = await sensors.flow.checkGpio();
            if (gpioErr) {
                errors.push(`gpiomon failed: ${gpioErr}`);
            }

            // Load sensor config and handle auto-assignment
            sensorConfig = loadSensorConfig();
            if (sensors.temperature.sensorCount === 1 && !sensorConfig) {
                // Single sensor — auto-assign as Hot
                const onlySensor = sensors.temperature.getAllSensors()[0];
                if (onlySensor.deviceId) {
                    saveSensorConfig({ sensors: { [onlySensor.deviceId]: "Hot" } });
                    sensors.temperature.renameSensors();
                    logger.log(LogSeverity.Info, LogArea.Temperature, "auto-assigned single sensor as Hot");
                }
            } else if (sensorConfig) {
                sensors.temperature.renameSensors();
            }

            // Check for missing configured sensors
            const missingSensors = sensors.temperature.getMissingSensors();
            for (const ms of missingSensors) {
                errors.push(`configured sensor missing: ${ms.id} (${ms.role})`);
            }

            // Check temperature sensor presence
            if (sensors.temperature.sensorCount === 0) {
                temperatureFailed = true;
                errors.push("no temperature sensors found");
            }

            // Check network connectivity
            const networkStatus = new NetworkStatus();
            const netInfo = await networkStatus.getNetworkDetails();
            let noConnection = false;
            let noGateway = false;
            if (!netInfo || !netInfo.IP) {
                noConnection = true;
                errors.push("no network connection detected");
            } else if (!netInfo.Gateway) {
                noGateway = true;
                errors.push("network connected but no gateway found");
            }

            if (errors.length > 0) {
                for (const err of errors) {
                    logger.log(LogSeverity.Severe, LogArea.General, `startup error: ${err}`);
                }
                // Pick the most specific error condition for LED display
                let condition: LedErrorCondition;
                if (noConnection) {
                    condition = "noConnection";
                } else if (noGateway) {
                    condition = "noGateway";
                } else if (temperatureFailed) {
                    condition = "noTemperature";
                } else if (loopbackFailed) {
                    condition = "noLoopback";
                } else {
                    condition = "other";
                }
                leds.startErrorFlash(condition);
            } else {
                leds.enterNormalMode();
                // Set initial LED states for normal operation
                leds.updatePumpLed(sensors.pump.state);
                leds.updateFlowLed(sensors.flow.lpm);
                const hotSensor = sensors.temperature.findByRole("Hot");
                leds.updateHotLed(hotSensor?.celsius);
            }

            const server = new FlowHttpServer(sensors);
            await server.start(opts.port);

            const homekit = new HomeKitBridge(sensors);
            await homekit.start();
            server.homekit = homekit;

            // Periodic heartbeat — log every 5 minutes so we can tell from logs
            // whether the process was alive, hung, or dead
            const HEARTBEAT_INTERVAL = 5 * MINUTE;
            setInterval(() => {
                const mem = process.memoryUsage();
                const sysFree = freemem();
                logger.log(LogSeverity.Detail, LogArea.Server,
                    `heartbeat pid ${process.pid}`
                    + ` — RSS ${(mem.rss / 1048576).toFixed(0)}MB heap ${(mem.heapUsed / 1048576).toFixed(0)}/${(mem.heapTotal / 1048576).toFixed(0)}MB`
                    + ` — system ${(sysFree / 1048576).toFixed(0)}MB free`
                    + ` — uptime ${formatDuration(process.uptime() * 1000)}`);
            }, HEARTBEAT_INTERVAL);

            // Breadcrumb: track the last exception/rejection event so the exit
            // handler can report what happened even if the process dies unexpectedly.
            let lastExceptionBreadcrumb = "";

            // Log process exit — this fires for ALL exits including OOM, signals, etc.
            process.on("exit", (code) => {
                // Use console.error since logger may not flush in time
                const uptime = formatDuration(process.uptime() * 1000);
                const mem = process.memoryUsage();
                let msg = `process exiting with code ${code} (pid ${process.pid})`
                    + ` — uptime ${uptime}`
                    + ` — RSS ${(mem.rss / 1048576).toFixed(0)}MB heap ${(mem.heapUsed / 1048576).toFixed(0)}/${(mem.heapTotal / 1048576).toFixed(0)}MB`;
                if (lastExceptionBreadcrumb) {
                    msg += ` — last event: ${lastExceptionBreadcrumb}`;
                }
                console.error(msg);
                try {
                    appendFileSync(sensors.activityLogger.logPath, `${timeString(Date.now())} :[Important](GENERAL) ${msg}\n`);
                } catch { /* best effort */ }
            });

            process.on("SIGINT", async () => {
                logger.log(LogSeverity.Important, LogArea.General, "shutting down (SIGINT)");
                await homekit.stop();
                sensors.stop();
                await server.stop();
                process.exit(0);
            });

            process.on("SIGTERM", async () => {
                logger.log(LogSeverity.Important, LogArea.General, "shutting down (SIGTERM)");
                await homekit.stop();
                sensors.stop();
                await server.stop();
                process.exit(0);
            });

            process.on("SIGHUP", () => {
                logger.log(LogSeverity.Important, LogArea.General, "received SIGHUP (ignoring)");
            });

            // Catch uncaught exceptions from @homebridge/ciao MDNSServer which crashes
            // when network interfaces change (WiFi connect/disconnect, AP start/stop).
            // Ciao throws AssertionErrors for various interface state transitions.
            process.on("uncaughtException", (err: Error) => {
                lastExceptionBreadcrumb = `uncaughtException ${err.name}: ${err.message}`;
                const isCiao = (err.name === "AssertionError" || err.name === "ERR_ASSERTION")
                    && (err.message.includes("IPv4 address changed")
                        || err.message.includes("IPv6 address changed")
                        || err.message.includes("Reached illegal state")
                        || err.message.includes("IP address version must match")
                        || err.message.includes("Netmask cannot have a version")
                        || err.stack?.includes("ciao"));
                if (isCiao) {
                    logger.log(LogSeverity.Info, LogArea.Server,
                        `suppressed ciao exception: ${err.message} — restarting in 2s`);
                    try {
                        appendFileSync(sensors.activityLogger.logPath,
                            `${timeString(Date.now())} :[Info](SERVER) suppressed ciao exception: ${err.message} — restarting in 2s\n`);
                    } catch { /* best effort */ }
                    // ciao is left in a broken state — restart cleanly so systemd brings it back healthy
                    setTimeout(() => {
                        sensors.stop();
                        process.exit(0);
                    }, 2000);
                    return;
                }
                logger.logError(LogSeverity.Severe, LogArea.General, err,
                    `uncaught exception (${err.name}: ${err.message})`);
                // Write to log file directly in case logger doesn't flush
                try {
                    appendFileSync(sensors.activityLogger.logPath,
                        `${timeString(Date.now())} :[Severe](GENERAL) FATAL uncaught: ${err.stack || err.message}\n`);
                } catch { /* best effort */ }
                sensors.stop();
                process.exit(1);
            });

            process.on("unhandledRejection", (reason: unknown) => {
                const err = reason instanceof Error ? reason : new Error(String(reason));
                lastExceptionBreadcrumb = `unhandledRejection ${err.name}: ${err.message}`;
                const isCiao = err.stack?.includes("ciao")
                    || ((err.name === "AssertionError" || err.name === "ERR_ASSERTION")
                        && (err.message.includes("address changed")
                            || err.message.includes("IP address version must match")
                            || err.message.includes("Netmask cannot have a version")));
                if (isCiao) {
                    logger.log(LogSeverity.Info, LogArea.Server,
                        `suppressed ciao rejection: ${err.message} — restarting in 2s`);
                    try {
                        appendFileSync(sensors.activityLogger.logPath,
                            `${timeString(Date.now())} :[Info](SERVER) suppressed ciao rejection: ${err.message} — restarting in 2s\n`);
                    } catch { /* best effort */ }
                    // ciao is left in a broken state — restart cleanly so systemd brings it back healthy
                    setTimeout(() => {
                        sensors.stop();
                        process.exit(0);
                    }, 2000);
                    return;
                }
                logger.logError(LogSeverity.Severe, LogArea.General, err,
                    `unhandled rejection (${err.name}: ${err.message})`);
                try {
                    appendFileSync(sensors.activityLogger.logPath,
                        `${timeString(Date.now())} :[Severe](GENERAL) FATAL unhandled rejection: ${err.stack || err.message}\n`);
                } catch { /* best effort */ }
                sensors.stop();
                process.exit(1);
            });
            break;
        }
    }
}

// Run if executed directly
if (require.main === module) {
    main(process.argv.slice(2)).catch((e) => {
        logger.logError(LogSeverity.Severe, LogArea.General, e, "fatal error");
        process.exit(1);
    });
}

// ---- Exports for testing ----

export {
    VERSION,
    SECOND,
    MINUTE,
    HOUR,
    DEFAULT_PORT,
    FLOW_START_DELAY,
    FLOW_STOP_DELAY,
    PUMP_MAX_RUN_TIME,
    CONFIG_FILE,
    LOG_FILE,
    HISTORY_FILE,
    LOG_MAX_ROTATIONS,
    TEMP_LOG_THRESHOLD,
    FlowConfig,
    loadConfig,
    applyConfig,
    periodToHertz,
    pwToFlow,
    sleep,
    timeString,
    logTimestamp,
    dateString,
    LogSeverity,
    LogArea,
    LogItem,
    Logger,
    TemperatureSensor,
    TemperatureManager,
    FlowSensor,
    SensorManager,
    FlowHttpServer,
    PumpController,
    ActivityLogger,
    HistoryStore,
    StatsAccumulator,
    parseArgs,
    main,
    StatusResponse,
    TemperatureSensorReading,
    TemperatureResponse,
    FlowResponse,
    CliOptions,
    DaySummary,
    RollingStats,
    StatsSnapshot,
    formatDuration,
    buildDashboardHtml,
    buildStatsCardHtml,
    formatMinutes,
    TempUnits,
    FlowUnits,
    formatTemp,
    formatFlow,
    formatVolume,
    cToF,
    lpmToGpm,
    runLoopbackTest,
    LoopbackResult,
    SENSOR_PIN,
    LOOPBACK_OUT_PIN,
    LOOPBACK_IN_PIN,
    PUMP_PIN,
    SensorConfig,
    SensorNameConfig,
    loadSensorConfig,
    saveSensorConfig,
    sensorDisplayName,
    buildSensorSetupHtml,
    Pump,
    PumpResponse,
    PumpSource,
    StatusLEDs,
    LedErrorCondition,
    HomeKitBridge,
    LocaleStrings,
    loadLocale,
    L,
    LOCALE,
    buildSettingsHtml,
    buildWifiHtml,
    scanWifiNetworks,
    WifiNetwork,
    saveConfig,
    getAvailableLocales,
    DayTimeline,
    TimelinePoint,
    PumpInterval,
    buildCalendarDayHtml,
    buildDayChartSvg,
    buildCalendarWeekHtml,
    buildCalendarMonthHtml,
    weekSunday,
    DoorMonitor,
    DoorEvent,
    SensorStatus,
    DOOR_STILL_OPEN_SENTINEL,
};
