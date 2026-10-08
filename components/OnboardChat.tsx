"use client";

/**
 * Intake: the citizen describes their circumstances in their own words.
 *
 * One large text box, not a form of thirty fields. The whole point of putting
 * a language model here is that someone can say "I am 67, a widow, I farm two
 * acres" instead of working out which box "landholding in hectares" goes in.
 *
 * Voice is offered because the audience includes people who do not type
 * comfortably, in a script many of them cannot type at all. It uses the
 * browser's own speech recognition — nothing is sent anywhere by this
 * component beyond the text the citizen can see and edit before submitting.
 *
 * What is shown back afterwards matters as much as the extraction: every field
 * understood, where it came from, and — importantly — anything that was
 * discarded because it failed validation. A system that quietly dropped a
 * misread value would look more certain than it is.
 */

import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";

import { translator, type Locale } from "@/lib/i18n";
import { buttonClass } from "./ui";

interface Field {
  key: string;
  label: string;
  value: unknown;
  provenance: string;
}

interface Question {
  key: string;
  question: string;
  questionHi?: string;
  blocks: string[];
}

interface Props {
  citizenId: string;
  locale: Locale;
  initialFields: Field[];
  initialQuestions: Question[];
}

/** Minimal shape of the browser speech API, which TypeScript does not ship. */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

function speechRecognition(): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

/**
 * Whether the browser can listen.
 *
 * Read through `useSyncExternalStore` rather than set from an effect. The
 * server cannot know, so it must render "no"; setting state in an effect to
 * correct that causes a cascading re-render on every mount, which React's
 * lint flags and which this audience's devices can least afford. This gives
 * React an explicit server snapshot instead.
 *
 * The result is cached because `getSnapshot` must return a stable value —
 * constructing a recogniser on every call would loop.
 */
let voiceSupportCache: boolean | null = null;

const subscribeToNothing = (): (() => void) => () => {};

function voiceSupported(): boolean {
  voiceSupportCache ??= speechRecognition() !== null;
  return voiceSupportCache;
}

function describeProvenance(provenance: string, t: ReturnType<typeof translator>): string {
  if (provenance === "DOCUMENT_VERIFIED") return t("why.fromDocument");
  if (provenance === "SELF_DECLARED") return t("why.youToldUs");
  if (provenance === "INFERRED") return t("why.inferred");
  return t("why.notEstablished");
}

export function OnboardChat({
  citizenId,
  locale,
  initialFields,
  initialQuestions,
}: Props) {
  const router = useRouter();
  const t = translator(locale);
  const [, startTransition] = useTransition();

  const [text, setText] = useState("");
  const [fields, setFields] = useState<Field[]>(initialFields);
  const [questions, setQuestions] = useState<Question[]>(initialQuestions);
  const [rejected, setRejected] = useState<Array<{ key: string; reason: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);

  const voiceAvailable = useSyncExternalStore(
    subscribeToNothing,
    voiceSupported,
    // The server cannot know, so it renders without the button.
    () => false,
  );

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  // Stop listening if the component goes away mid-sentence.
  useEffect(() => () => recognitionRef.current?.stop(), []);

  function toggleVoice(): void {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const recognition = speechRecognition();
    if (!recognition) return;

    recognition.lang = locale === "hi" ? "hi-IN" : "en-IN";
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      let heard = "";
      for (let i = 0; i < event.results.length; i += 1) {
        heard += `${event.results[i][0].transcript} `;
      }
      // Appended to the box rather than submitted: the citizen sees what was
      // heard and can correct it before anything is extracted from it.
      setText((previous) => `${previous}${previous ? " " : ""}${heard.trim()}`);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  async function submit(): Promise<void> {
    if (text.trim() === "") return;

    setBusy(true);
    setError(null);
    recognitionRef.current?.stop();
    setListening(false);

    try {
      const response = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ citizenId, intake: text }),
      });
      const payload = (await response.json()) as
        | {
            ok: true;
            data: {
              profile: Field[];
              questions: Question[];
              rejected: Array<{ key: string; reason: string }>;
            };
          }
        | { ok: false; error: { message: string } };

      if (!payload.ok) {
        setError(payload.error.message);
        return;
      }

      setFields(payload.data.profile);
      setQuestions(payload.data.questions);
      setRejected(payload.data.rejected);
      setText("");
    } catch {
      setError("We could not save that just now. Please try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function discover(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/entitlements/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ citizenId }),
      });
      if (!response.ok) {
        setError("We could not work out your benefits just now.");
        return;
      }
      startTransition(() => router.push("/dashboard"));
    } catch {
      setError("We could not work out your benefits just now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-[var(--radius-panel)] border bg-surface p-5">
        <label htmlFor="intake" className="block text-lg font-medium">
          {locale === "hi"
            ? "अपने बारे में बताइए"
            : "Tell us about yourself"}
        </label>
        <p className="mt-1 text-sm text-muted">
          {locale === "hi"
            ? "अपने शब्दों में लिखिए या बोलिए — उम्र, काम, कहाँ रहते हैं, घर में कितने लोग हैं।"
            : "In your own words, by typing or speaking. Your age, your work, where you live, who is in your household."}
        </p>

        <textarea
          id="intake"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          disabled={busy}
          placeholder={
            locale === "hi"
              ? "जैसे: मैं 67 साल की हूँ, विधवा हूँ, बिहार के एक गाँव में रहती हूँ और दो एकड़ खेती करती हूँ।"
              : "For example: I am 67, a widow, I live in a village in Bihar and I farm two acres."
          }
          className="mt-3 w-full rounded-[var(--radius-card)] border bg-surface px-3 py-2.5 text-base leading-relaxed"
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || text.trim() === ""}
            className={buttonClass.primary}
          >
            {busy
              ? locale === "hi"
                ? "समझा जा रहा है…"
                : "Understanding…"
              : locale === "hi"
                ? "आगे बढ़ें"
                : "Continue"}
          </button>

          {voiceAvailable ? (
            <button
              type="button"
              onClick={toggleVoice}
              disabled={busy}
              aria-pressed={listening}
              className={`${buttonClass.secondary} ${
                listening ? "border-[var(--bad-border)] text-[var(--bad)]" : ""
              }`}
            >
              <span aria-hidden="true">{listening ? "■" : "🎙"}</span>
              {listening
                ? locale === "hi"
                  ? "सुनना बंद करें"
                  : "Stop listening"
                : locale === "hi"
                  ? "बोलकर बताएँ"
                  : "Speak instead"}
            </button>
          ) : null}
        </div>

        {listening ? (
          <p className="mt-2 text-sm text-[var(--bad)]" role="status">
            {locale === "hi"
              ? "सुन रहे हैं… बोलिए, फिर रोकें।"
              : "Listening… speak, then stop. You can edit the text before continuing."}
          </p>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-[var(--radius-card)] border border-[var(--bad-border)] bg-[var(--bad-soft)] px-3 py-2 text-sm text-[var(--bad)]"
          >
            {error}
          </p>
        ) : null}
      </div>

      {/* ------------------------------------------------ what we understood */}
      {fields.length > 0 ? (
        <div className="rounded-[var(--radius-panel)] border bg-surface p-5">
          <h2 className="font-semibold">
            {locale === "hi" ? "हमने यह समझा" : "What we understood"}
          </h2>
          <ul className="mt-3 divide-y text-sm">
            {fields.map((field) => (
              <li
                key={field.key}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="font-medium">{field.label}</span>
                <span className="flex items-center gap-2">
                  <span className="tabular">
                    {typeof field.value === "boolean"
                      ? field.value
                        ? locale === "hi"
                          ? "हाँ"
                          : "Yes"
                        : locale === "hi"
                          ? "नहीं"
                          : "No"
                      : String(field.value ?? "—")}
                  </span>
                  <span className="text-xs text-subtle">
                    {describeProvenance(field.provenance, t)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        Shown, not swallowed. A value the extractor got wrong and the validator
        discarded is something the citizen may want to correct, and hiding it
        would make the system look more certain than it is.
      */}
      {rejected.length > 0 ? (
        <div className="rounded-[var(--radius-panel)] border border-[var(--warn-border)] bg-[var(--warn-soft)] p-5">
          <h2 className="font-semibold text-[var(--warn)]">
            {locale === "hi"
              ? "यह हम ठीक से नहीं समझ पाए"
              : "We could not use these"}
          </h2>
          <ul className="mt-2 list-inside list-disc text-sm text-[var(--warn)]">
            {rejected.map((item) => (
              <li key={item.key}>
                {item.key}: {item.reason}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-[var(--warn)]">
            {locale === "hi"
              ? "इन्हें छोड़ दिया गया है — ग़लत जानकारी पर फ़ैसला लेने से बेहतर है कि हम दोबारा पूछें।"
              : "These were discarded rather than guessed at. We would rather ask again than decide on a misread value."}
          </p>
        </div>
      ) : null}

      {/* -------------------------------------------- what we still need */}
      {questions.length > 0 ? (
        <div className="rounded-[var(--radius-panel)] border bg-surface p-5">
          <h2 className="font-semibold">
            {locale === "hi"
              ? "अभी यह जानना बाकी है"
              : "What we still need to know"}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {locale === "hi"
              ? "ये सवाल इसलिए पूछे जा रहे हैं क्योंकि किसी योजना का नियम इन पर टिका है। सबसे ऊपर वाला सबसे ज़्यादा काम का है।"
              : "Each of these is asked because a scheme's rule depends on it. The first one unblocks the most."}
          </p>
          <ol className="mt-3 space-y-2 text-sm">
            {questions.slice(0, 5).map((question) => (
              <li key={question.key} className="border-t pt-2 first:border-t-0 first:pt-0">
                <p className="font-medium">
                  {locale === "hi" && question.questionHi
                    ? question.questionHi
                    : question.question}
                </p>
                <p className="text-xs text-subtle">
                  {locale === "hi" ? "इससे जुड़ी योजनाएँ: " : "Affects: "}
                  {question.blocks.join(", ")}
                </p>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-sm text-muted">
            {locale === "hi"
              ? "आप इन्हें अभी बता सकते हैं, या आगे बढ़कर बाद में भी।"
              : "You can answer these now in the box above, or carry on and come back to them."}
          </p>
        </div>
      ) : null}

      {fields.length > 0 ? (
        <button
          type="button"
          onClick={() => void discover()}
          disabled={busy}
          className={`${buttonClass.primary} w-full py-4 text-lg`}
        >
          {busy
            ? locale === "hi"
              ? "देख रहे हैं…"
              : "Working it out…"
            : locale === "hi"
              ? "मेरे लाभ दिखाइए"
              : "Show me my benefits"}
        </button>
      ) : null}
    </div>
  );
}
