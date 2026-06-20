import { describe, expect, it } from "vitest";

import { parsePlanTasks, planParallelGroups, type PlanTask } from "../plan-tasks.js";

const J = (o: unknown) => JSON.stringify(o);

describe("parsePlanTasks", () => {
  it("parses a valid task graph", () => {
    const tasks = parsePlanTasks(
      J({
        version: 1,
        tasks: [
          { id: "t1", title: "A", fileScope: ["a.ts"], dependsOn: [], parallelSafe: true },
        ],
      })
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("t1");
  });
  it("returns [] on invalid JSON", () => {
    expect(parsePlanTasks("{ not json")).toEqual([]);
  });
  it("returns [] when tasks is missing or not an array", () => {
    expect(parsePlanTasks(J({ version: 1 }))).toEqual([]);
    expect(parsePlanTasks(J({ tasks: "nope" }))).toEqual([]);
  });
  it("returns [] on a malformed task", () => {
    expect(
      parsePlanTasks(J({ tasks: [{ id: "t1", title: "A" }] }))
    ).toEqual([]);
  });
  it("returns [] on duplicate ids", () => {
    expect(
      parsePlanTasks(
        J({
          tasks: [
            { id: "t1", title: "A", fileScope: [], dependsOn: [], parallelSafe: true },
            { id: "t1", title: "B", fileScope: [], dependsOn: [], parallelSafe: true },
          ],
        })
      )
    ).toEqual([]);
  });
  it("returns [] on a dangling dependency", () => {
    expect(
      parsePlanTasks(
        J({
          tasks: [
            { id: "t1", title: "A", fileScope: [], dependsOn: ["nope"], parallelSafe: true },
          ],
        })
      )
    ).toEqual([]);
  });
  it("returns [] on a dependency cycle", () => {
    expect(
      parsePlanTasks(
        J({
          tasks: [
            { id: "t1", title: "A", fileScope: [], dependsOn: ["t2"], parallelSafe: true },
            { id: "t2", title: "B", fileScope: [], dependsOn: ["t1"], parallelSafe: true },
          ],
        })
      )
    ).toEqual([]);
  });
});

describe("planParallelGroups", () => {
  const t = (
    id: string,
    fileScope: string[],
    dependsOn: string[] = [],
    parallelSafe = true
  ): PlanTask => ({ id, title: id, fileScope, dependsOn, parallelSafe });

  it("groups disjoint parallel-safe tasks into one wave", () => {
    const w = planParallelGroups([t("t1", ["a.ts"]), t("t2", ["b.ts"])]);
    expect(w).toHaveLength(1);
    expect(w[0].map((x) => x.id).sort()).toEqual(["t1", "t2"]);
  });
  it("splits overlapping file scopes into separate waves", () => {
    const w = planParallelGroups([t("t1", ["a.ts"]), t("t2", ["a.ts"])]);
    expect(w).toHaveLength(2);
  });
  it("respects dependencies (dependent task in a later wave)", () => {
    const w = planParallelGroups([t("t1", ["a.ts"]), t("t2", ["b.ts"], ["t1"])]);
    expect(w[0].map((x) => x.id)).toEqual(["t1"]);
    expect(w[1].map((x) => x.id)).toEqual(["t2"]);
  });
  it("puts a non-parallel-safe task in its own singleton wave", () => {
    const w = planParallelGroups([t("t1", ["a.ts"]), t("t2", ["b.ts"], [], false)]);
    expect(w.some((wave) => wave.length === 1 && wave[0].id === "t2")).toBe(true);
  });
  it("returns no waves for an empty task list", () => {
    expect(planParallelGroups([])).toEqual([]);
  });
});
