import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("../../supabase", () => ({ createServerSupabase: () => mock }));
vi.mock("../../storage", () => ({ deleteFile: vi.fn() }));
vi.mock("../../observability/sentry", () => ({ reportError: vi.fn() }));
import { startDbJobRunner, stopDbJobIntake, stopDbJobRunner } from "../runner";

beforeEach(() => {
    vi.useFakeTimers();
    mock.rpc.mockReset().mockResolvedValue({ data: [], error: null });
    mock.from.mockReset();
    vi.stubEnv("DB_JOBS_ENABLED", "true");
    vi.stubEnv("DB_JOBS_POLL_MS", "5000");
});
afterEach(async () => {
    await stopDbJobRunner();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});
describe("DB runner intake lifecycle", () => {
    it("cancels both delayed startup callbacks before they can query", async () => {
        startDbJobRunner({});
        stopDbJobIntake();
        await vi.advanceTimersByTimeAsync(120000);
        expect(mock.rpc).not.toHaveBeenCalled();
        expect(mock.from).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it("drains a claim already sent but never starts its late returned handler", async () => {
        let release!: (value: unknown) => void;
        mock.rpc.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const handler = vi.fn();
        startDbJobRunner({ fixture: handler });
        await vi.advanceTimersByTimeAsync(1000);
        expect(mock.rpc).toHaveBeenCalledTimes(1);
        const draining = stopDbJobRunner();
        await vi.advanceTimersByTimeAsync(20000);
        expect(mock.rpc).toHaveBeenCalledTimes(1);
        release({ data: [{ id: "late", kind: "fixture" }], error: null });
        await draining;
        expect(handler).not.toHaveBeenCalled();
        expect(mock.from).not.toHaveBeenCalled();
    });
    it("an old draining generation cannot clear a restarted runner", async () => {
        let release!: (value: unknown) => void;
        mock.rpc.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        startDbJobRunner({});
        await vi.advanceTimersByTimeAsync(1000);
        const oldDrain = stopDbJobRunner();
        startDbJobRunner({});
        release({ data: [], error: null });
        await oldDrain;
        await vi.advanceTimersByTimeAsync(1000);
        expect(mock.rpc).toHaveBeenCalledTimes(2);
        await stopDbJobRunner();
        await stopDbJobRunner();
        await vi.advanceTimersByTimeAsync(60000);
        expect(mock.rpc).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });
});
