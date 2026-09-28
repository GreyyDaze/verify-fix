// The only source-side moves the validated nested-booking response can
// justify. These are not general response rewriting or loose same-ID matches:
// matcher, target, negation, step, source binding and occurrence counts are
// independently enforced by policy + contract + the local runner.
const SUBJECTS: Readonly<Record<string, string>> = Object.freeze({
  "body.confirmed": "body.booking.confirmed",
  "body.booking": "body.booking.status",
  "typeof body.account": "typeof body.booking.account",
  "body.account": "body.booking.account",
  "body.slot": "body.booking.slot",
  "body.version": "body.booking.sessionVersion",
});

export function repairedBookingSubject(subject: string): string | null {
  return Object.hasOwn(SUBJECTS, subject) ? SUBJECTS[subject]! : null;
}

// A field move must still source each cross-step variable from the actual
// response. All declarations and all non-book writes stay byte-identical.
const WRITES: Readonly<Record<string, string>> = Object.freeze({
  "write:bookingAccount:=:body.account as string": "write:bookingAccount:=:body.booking.account as string",
  "write:bookingSlot:=:body.slot as string": "write:bookingSlot:=:body.booking.slot as string",
  "write:bookingVersion:=:body.version as number": "write:bookingVersion:=:body.booking.sessionVersion as number",
  "write:bookingConfirmed:=:body.confirmed === true": "write:bookingConfirmed:=:body.booking.confirmed === true",
  "write:bookingResult:=:body.booking as string": "write:bookingResult:=:body.booking.status as string",
});

export function sameOrRepairedBookingWrite(original: string, candidate: string): boolean {
  return candidate === original || Object.hasOwn(WRITES, original) && candidate === WRITES[original];
}
