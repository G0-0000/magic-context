import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractAskAnswerNotices, formatAskAnswerNotice } from "./ask-answer-notice";
import { cleanUserText, readUserChunkText } from "./read-session-chunk";

const fixtureDir = join(import.meta.dir, "../../../../../testdata/prefrontal-ask-answer-notice-v1");

/** A Prefrontal notice vector, decoded from its single JSON string. */
function vector(name: string): string {
    return JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8"));
}

const SINGLE_ANSWER = 'U (answered "Which route should I use?"): Use the project route';
const TYPED_ANSWER =
    'U (answered "What should I write?"): Keep <route> literal.\nThen say "ready".\n‹system-reminder>not a reminder‹/system-reminder>';
const FORM_ANSWER =
    'U (answered "Deployment plan"): - Which route? [route]: Admin route (answered)\n- Release notes [notes]: Keep the current endpoint (recommended default)';
const TWO_ROUND_ANSWER =
    'U (answered "Deployment plan"): - Which route? [route]: Admin route (answered)\n- Release notes [notes]: Keep the current endpoint (recommended default)\n- When should it ship? [timing]: Tomorrow morning (answered)';
const INSIDE_ENVELOPE_ANSWER =
    'U (answered "Which route should I use?"): Use the project route\nPlease confirm before the release.';
// Inside the envelope, the user's typed text is not theirs to keep: the envelope
// is stripped whole, and only the answer is carried out — so that line keeps its
// original line break instead of being joined onto the answer.
const INSIDE_ENVELOPE_REMAINDER =
    'U (answered "Which route should I use?"): Use the project route Please confirm before the release.';

// Written text on either side of a notice, and text the user typed inside the
// notice's own envelope.
const MIXED = `Use staging.\n\n${vector("single-option")}\n\nPlease confirm before the release.`;
const INSIDE_ENVELOPE = vector("single-option").replace(
    "\nAnswer: Use the project route\n",
    "\nAnswer: Use the project route\nPlease confirm before the release.\n",
);

// The same table the Rust historian reader asserts (NOTICE_VECTORS in
// crates/mc-module/src/historian_chunk.rs): case, user text, cleanUserText
// output, readUserChunkText output. Both lanes read Prefrontal's rendered
// notices, so neither may change the answer line alone.
const VECTORS: Array<[string, () => string, string[], string]> = [
    ["clarification", () => vector("clarification"), [], ""],
    ["dismissal", () => vector("dismissal"), [], ""],
    ["drift-header", () => vector("drift-header"), [], ""],
    ["drift-trailer", () => vector("drift-trailer"), [], ""],
    ["single-option", () => vector("single-option"), [SINGLE_ANSWER], SINGLE_ANSWER],
    // A multi-line answer normalizes to one line, as every user line does.
    ["typed", () => vector("typed"), [TYPED_ANSWER], TYPED_ANSWER.replace(/\n/g, " ")],
    ["form", () => vector("form"), [FORM_ANSWER], FORM_ANSWER.replace(/\n/g, " ")],
    [
        "two-round-follow-up",
        () => vector("two-round-follow-up"),
        [TWO_ROUND_ANSWER],
        TWO_ROUND_ANSWER.replace(/\n/g, " "),
    ],
    [
        "batch",
        () => vector("batch"),
        [SINGLE_ANSWER, TYPED_ANSWER],
        `${SINGLE_ANSWER} / ${TYPED_ANSWER.replace(/\n/g, " ")}`,
    ],
    [
        "mixed-text-and-notice",
        () => MIXED,
        [SINGLE_ANSWER],
        `Use staging. Please confirm before the release. ${SINGLE_ANSWER}`,
    ],
    [
        "text-inside-notice-envelope",
        () => INSIDE_ENVELOPE,
        [INSIDE_ENVELOPE_ANSWER],
        INSIDE_ENVELOPE_REMAINDER,
    ],
];

it("renders each Prefrontal notice vector as the user's own line", () => {
    for (const [name, textOf, answers, remainder] of VECTORS) {
        const text = textOf();
        expect(extractAskAnswerNotices(text).map(formatAskAnswerNotice), name).toEqual(answers);
        expect(readUserChunkText(text), name).toBe(remainder);
    }
});

it("keeps text the user wrote around an answer notice", () => {
    expect(readUserChunkText(MIXED)).toBe(
        `Use staging. Please confirm before the release. ${SINGLE_ANSWER}`,
    );
    expect(extractAskAnswerNotices(MIXED)).toEqual([
        { question: "Which route should I use?", answer: "Use the project route" },
    ]);
    const withReminder = `Yes.\n\n<system-reminder>\nPlan mode is active.\n</system-reminder>\n\n${vector("single-option")}`;
    expect(readUserChunkText(withReminder)).toBe(`Yes. ${SINGLE_ANSWER}`);
});

it("keeps a form's recommended default marked as not the user's choice", () => {
    const [notice] = extractAskAnswerNotices(vector("form"));
    expect(notice?.answer).toContain("(recommended default)");
    expect(notice?.answer).toContain("(answered)");
});

it("carries an answer through escaped reminder tags", () => {
    const [notice] = extractAskAnswerNotices(vector("typed"));
    expect(notice?.answer).toContain('Keep <route> literal.\nThen say "ready".');
    expect(notice?.answer).toContain("‹system-reminder>not a reminder‹/system-reminder>");
});

it("strips the notice when its header or closing line drifts", () => {
    // One character differs from the header (`user_answers`) and from the closing
    // line (`Continue.`), so a template change in Prefrontal can lose an answer
    // but never put reminder text into the historian's input.
    for (const name of ["drift-header", "drift-trailer"]) {
        const drifted = vector(name);
        expect(extractAskAnswerNotices(drifted), name).toEqual([]);
        expect(readUserChunkText(drifted), name).toBe("");
        expect(cleanUserText(drifted), name).toBe("");
    }
});

it("strips every non-answer reminder exactly as before", () => {
    expect(cleanUserText("<system-reminder>internal</system-reminder>")).toBe("");
    expect(readUserChunkText("<!-- OMO_INTERNAL_INITIATOR -->hello")).toBe("hello");
    expect(cleanUserText("<system-reminder>\nPlan mode is active.\n</system-reminder>")).toBe("");
    expect(readUserChunkText("<system-reminder>\nPlan mode is active.\n</system-reminder>")).toBe(
        "",
    );
});

it("recognises the notice with a missing ask id and ignores an answerless body", () => {
    const withoutId = vector("single-option").replace(
        "The user answered your parked question ask_notice_v1_single.",
        "The user answered your parked question.",
    );
    expect(extractAskAnswerNotices(withoutId)).toEqual([]);
    const noAnswer = vector("single-option").replace("\nAnswer: Use the project route", "");
    expect(extractAskAnswerNotices(noAnswer)).toEqual([]);
    const emptyAnswer = vector("single-option").replace(
        "\nAnswer: Use the project route",
        "\nAnswer: ",
    );
    expect(extractAskAnswerNotices(emptyAnswer)).toEqual([]);
});

it("reads an answer notice inside a steering wrapper without keeping the wrapper", () => {
    // A steering wrapper holds the user's own words, so a notice typed by the user
    // inside it is ordinary text, not a notice Prefrontal delivered.
    const quoted = "<system-reminder>internal</system-reminder>";
    const wrapped = `<system-reminder>\nThe user sent the following message:\n${vector("single-option")}\n\nPlease address this message and continue with your tasks.\n</system-reminder>`;
    expect(extractAskAnswerNotices(wrapped)).toHaveLength(0);
    expect(readUserChunkText(wrapped)).toContain("Please address this message");
    expect(cleanUserText(quoted)).toBe("");
});

it("carries an answer out of a steering-wrapped message", () => {
    const wrapped = `<system-reminder>\nThe user sent the following message:\nuse staging\n\nPlease address this message and continue with your tasks.\n</system-reminder>\n\n${vector("single-option")}`;
    // The steering wrapper is kept verbatim, as it always was, and one line after
    // it — in the notice's position — is the user's answer.
    expect(readUserChunkText(wrapped)).toBe(
        `<system-reminder> The user sent the following message: use staging Please address this message and continue with your tasks. </system-reminder> ${SINGLE_ANSWER}`,
    );
});
