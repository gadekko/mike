import type { Db, DbJob } from "./types";

/** Immutable attempt identity. A null claimedAt never authorizes settlement. */
export type ClaimIdentity = {
    id: string;
    attempts: number;
    claimedAt: string | null;
};

export type Settlement =
    | { kind: "committed" }
    | { kind: "ownership_lost" }
    | { kind: "outcome_unknown"; error: unknown };

export type SettlementPatch = {
    status: "done" | "pending" | "failed";
    finished_at?: string | null;
    last_error: string | null;
    result?: DbJob["result"];
    run_at?: string;
    attempts?: number;
    max_attempts?: number;
};

export function claimIdentity(
    job: Pick<DbJob, "id" | "attempts" | "claimed_at">,
): ClaimIdentity {
    return { id: job.id, attempts: job.attempts, claimedAt: job.claimed_at };
}

/** Contain transport exceptions: an uncertain write must never become a retry. */
export async function settleClaim(
    db: Db,
    claim: ClaimIdentity,
    patch: SettlementPatch,
): Promise<Settlement> {
    if (!claim.claimedAt) return { kind: "ownership_lost" };
    try {
        const { data, error } = await db.from("db_jobs").update(patch)
            .eq("id", claim.id)
            .eq("status", "running")
            .eq("attempts", claim.attempts)
            .eq("claimed_at", claim.claimedAt)
            .select("id");
        if (error) return { kind: "outcome_unknown", error };
        if (Array.isArray(data) && data.length === 1 && data[0].id === claim.id)
            return { kind: "committed" };
        if (Array.isArray(data) && data.length === 0)
            return { kind: "ownership_lost" };
        return { kind: "outcome_unknown", error: new Error("invalid_settlement_response") };
    } catch (error) {
        return { kind: "outcome_unknown", error };
    }
}
