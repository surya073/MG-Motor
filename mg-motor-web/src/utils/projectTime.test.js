import { parseProjectDateTime } from "./projectTime";
import { timeAgo } from "../layouts/MainLayout/Navbar/NotificationBell";

jest.mock("react-router-dom", () => ({ useNavigate: () => jest.fn() }));

const SYD = "Australia/Sydney";

test("a Catalyst time is read in the project zone, not the browser's", () => {
  // 15:22:51 AEDT (UTC+11) on 23 Nov 2026 is 04:22:51 UTC.
  expect(parseProjectDateTime("2026-11-23 15:22:51:802", SYD).toISOString()).toBe("2026-11-23T04:22:51.802Z");
  expect(parseProjectDateTime("2026-11-23 15:22:51", SYD).toISOString()).toBe("2026-11-23T04:22:51.000Z");
});

test("winter (AEST, UTC+10) and the daylight-saving changeover are handled", () => {
  expect(parseProjectDateTime("2026-07-01 10:00:00", SYD).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  // DST starts 4 Oct 2026 at 02:00 AEST -> 03:00 AEDT.
  expect(parseProjectDateTime("2026-10-04 01:30:00", SYD).toISOString()).toBe("2026-10-03T15:30:00.000Z");
  expect(parseProjectDateTime("2026-10-04 03:30:00", SYD).toISOString()).toBe("2026-10-03T16:30:00.000Z");
});

test("values with an explicit offset, and junk, are handled", () => {
  expect(parseProjectDateTime("2026-11-23T04:22:51Z", SYD).toISOString()).toBe("2026-11-23T04:22:51.000Z");
  expect(parseProjectDateTime("", SYD)).toBeNull();
  expect(parseProjectDateTime(null, SYD)).toBeNull();
  expect(parseProjectDateTime("not a date", SYD)).toBeNull();
});

test("the bell shows the real age, wherever the viewer is", () => {
  const now = Date.parse("2026-11-23T06:22:51Z"); // 17:22:51 AEDT
  expect(timeAgo("2026-11-23 15:22:51:000", now)).toBe("2h ago");
  expect(timeAgo("2026-11-23 17:12:51:000", now)).toBe("10m ago");
  expect(timeAgo("2026-11-23 17:22:30:000", now)).toBe("Just now");
  expect(timeAgo("2026-11-20 09:10:36:561", now)).toBe("3d ago");
});
