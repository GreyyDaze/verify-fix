// Trusted local detection capability. The stored incident is admitted ONLY by
// the unchanged remote v3 loader. A caller-supplied Scene/Bundle, a passing
// side, a local asset, or a self-declared mode cannot grant this capability.
// This does not add a recording schema, a provenance kind, or a verdict law.
import { loadBundle } from "../bundle.ts";
import type { Bundle, Scene } from "../types.ts";
import { MULTISTEP_DETECTION_MODE } from "../scene/modes.ts";
import type { MultiStepFailureAssertion } from "./capture.ts";
import { validMultiStepStoredRecording } from "./recording-schema.ts";
import { readBoundedBundleFile } from "./files.ts";
import { recordedNestedBookingConfirmed } from "./shape.ts";

export interface TrustedMultiStepDetection {
  readonly failureAssertion: MultiStepFailureAssertion;
}

/** Re-open the on-disk bundle at the point of execution. The loader rebinds
 * remote result+asset hashes, reporter, original source, failure line, and
 * provenance; it rejects a changed or locally constructed recording. */
export function trustedMultiStepDetection(bundle: Bundle, scene: Scene): TrustedMultiStepDetection | null {
  if (bundle.schemaVersion !== "v3" || bundle.check.checkType !== "MULTI_STEP"
    || scene.type !== "DETECTION" || scene.sceneId !== "detection"
    || scene.mode !== MULTISTEP_DETECTION_MODE || scene.verdict.mustFail !== true) return null;
  try {
    const recordPath = "recordings/failing.multistep.json";
    const bytes = readBoundedBundleFile(bundle.dir, recordPath, 2 * 1024 * 1024);
    const loaded = loadBundle(bundle.dir).bundle;
    if (readBoundedBundleFile(bundle.dir, recordPath, 2 * 1024 * 1024) !== bytes) return null;
    const failure = loaded.multistep?.failureAssertion;
    const boundScene = loaded.scenes.find((item) => item.type === "DETECTION");
    if (loaded.multistep?.problems.length || !failure || !boundScene
      || JSON.stringify(scene) !== JSON.stringify(boundScene)
      // Rebind every *authority-bearing* in-memory value. Determinism and
      // environment assumptions are independent decision-law prerequisites:
      // a synthetic test may supply them without gaining mutation authority.
      // A caller cannot borrow a valid recording with a different source,
      // scene, construct/config, or failing-side binding.
      || (["dir", "check", "checkSource", "files", "configFile", "config", "scenes",
        "multistep", "recordedOrigin", "oracleProvenance"] as const).some((key) =>
        JSON.stringify(bundle[key]) !== JSON.stringify(loaded[key]))
      || !scene.assertionsInvolved.includes(failure.id)
      || scene.verdict.provenance.kind !== "recorded"
      || scene.verdict.provenance.artifactId !== "recordings/failing.multistep.json") return null;
    // Only the exact bounded file just admitted by the remote-only loader
    // supplies the mutation fact, never a manifest hint or passing response.
    const recording: unknown = JSON.parse(bytes);
    if (!validMultiStepStoredRecording(recording, "failing")
      || !recording.binding.failureAssertion
      || !recordedNestedBookingConfirmed(recording.steps)
      || recording.binding.resultId !== scene.verdict.provenance.runId
      || recording.binding.failureAssertion?.id !== failure.id
      || recording.binding.failureAssertion?.line !== failure.line
      || recording.binding.failureAssertion?.subject !== "body.confirmed"
      || recording.binding.failureAssertion?.repairedSubject !== "body.booking.confirmed") return null;
    return { failureAssertion: recording.binding.failureAssertion };
  } catch {
    return null; // fixed category: never echo paths, asset URLs or secrets
  }
}
