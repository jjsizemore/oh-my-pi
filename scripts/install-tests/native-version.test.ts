import { describe, expect, it } from "bun:test";
import { nativeVersionFromExports, requireNativeVersion } from "./native-version";

describe("native addon release sentinel", () => {
	it("normalizes the unique version sentinel", () => {
		expect(nativeVersionFromExports(["load", "__piNativesV17_2_6", "other"])).toBe("17.2.6");
	});

	it("rejects missing or ambiguous sentinels", () => {
		expect(nativeVersionFromExports(["load"])).toBeUndefined();
		expect(nativeVersionFromExports(["__piNativesV17_2_6", "__piNativesV17_2_7"])).toBeUndefined();
	});

	it("requires the checkout version before an addon can be shared with test jobs", () => {
		expect(requireNativeVersion(["__piNativesV17_2_10"], "17.2.10")).toBe("17.2.10");
		expect(() => requireNativeVersion(["__piNativesV17_2_9"], "17.2.10")).toThrow(
			"Native addon version mismatch: expected 17.2.10, received 17.2.9",
		);
		expect(() => requireNativeVersion(["__piNativesBuildVersion"], "17.2.10")).toThrow(
			"Native addon has no unique release version sentinel",
		);
		expect(() => requireNativeVersion(["__piNativesV17_2_9", "__piNativesV17_2_10"], "17.2.10")).toThrow(
			"Native addon has no unique release version sentinel",
		);
	});
});
