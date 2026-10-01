import EventSource from "react-native-sse";
import { api } from "../client";
import { followJob } from "../stream";

jest.mock("react-native-sse", () => jest.fn().mockImplementation(() => ({
  addEventListener: jest.fn(), close: jest.fn(),
})));
jest.mock("../client", () => ({ api: { job: jest.fn() }, baseUrl: () => "https://test", accessToken: () => "token" }));

function source() {
  return (EventSource as jest.Mock).mock.results.slice(-1)[0].value;
}
function connectionError() {
  for (const [name, fn] of source().addEventListener.mock.calls) {
    if (name === "error") fn({});
  }
}
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test("closing a stream resolves the caller and ignores late events", async () => {
  const update = jest.fn();
  const follow = followJob("one", update);
  follow.close();
  await expect(follow.promise).resolves.toMatchObject({ text: "" });
  for (const [name, fn] of source().addEventListener.mock.calls) {
    if (name === "token") fn({ data: JSON.stringify({ type: "token", content: "late" }) });
  }
  expect(update).not.toHaveBeenCalled();
});

test("repeated connection errors start one polling loop", async () => {
  (api.job as jest.Mock).mockResolvedValue({ status: "completed", result: { assistant_text: "done" }, pending_facts: [] });
  const follow = followJob("two", jest.fn());
  connectionError(); connectionError();
  await jest.advanceTimersByTimeAsync(1000);
  await expect(follow.promise).resolves.toMatchObject({ text: "done", finished: "done" });
  expect(api.job).toHaveBeenCalledTimes(1);
});

test("closing while a poll is in flight suppresses its result", async () => {
  let resolveJob!: (value: unknown) => void;
  (api.job as jest.Mock).mockReturnValue(new Promise((resolve) => { resolveJob = resolve; }));
  const update = jest.fn();
  const follow = followJob("three", update);
  connectionError();
  await jest.advanceTimersByTimeAsync(1000);
  follow.close();
  resolveJob({ status: "completed", result: { assistant_text: "late" }, pending_facts: [] });
  await follow.promise;
  await Promise.resolve();
  expect(update).not.toHaveBeenCalled();
});
