"""The voice agent: turn events, speculation, barge-in, cancellation, history after errors, the normaliser, the prosody
plan and the routes, with a scripted model and a fake voice, so no key, no network and no cost."""
from __future__ import annotations

import base64
import json
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.core.errors import ApiError
from backend.app.main import create_app
from backend.app.services import voice_agent as va
from backend.app.services import voice_heard, voice_prosody as vp, voice_text as vt, voice_turns as vtn
from backend.app.services.spend import SpendTracker
from backend.app.settings import Settings
from backend.tests.test_aftercare import reply, text
from backend.tests.test_api import LAB, FakeClient

HAIKU = "claude-haiku-5-5"


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class Stream:
    """One scripted reply: deltas, then an optional exception, with an optional gate to hold it half way."""

    def __init__(self, deltas: list[str], error: BaseException | None = None, gate: threading.Event | None = None,
                 hold_after: int = 1):
        self.deltas, self.error, self.gate, self.hold_after = deltas, error, gate, hold_after
        self.reached = threading.Event()  # set when the stream is waiting at the gate
        self.closed = False

    def __enter__(self) -> "Stream":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.closed = True

    @property
    def text_stream(self):
        for i, d in enumerate(self.deltas):
            if self.gate is not None and i == self.hold_after:
                self.reached.set()
                self.gate.wait(5)
            yield d
        if self.error:
            raise self.error

    def get_final_message(self):
        return reply(HAIKU, text("".join(self.deltas)))


class FakeClaude:
    def __init__(self, script: list[Stream]):
        self.script, self.calls = script, []
        self._lock = threading.Lock()

    def stream(self, **params: Any) -> Stream:
        with self._lock:
            self.calls.append(params)
            return self.script.pop(0)


class FakeRest:
    def __init__(self) -> None:
        self.ssml: list[str] = []
        self.fail_on: int | None = None

    def synthesize(self, ssml: str) -> bytes:
        self.ssml.append(ssml)
        if self.fail_on is not None and len(self.ssml) == self.fail_on:
            raise RuntimeError("Azure Speech refused the request (HTTP 500).")
        content = "".join(ssml.split("<voice")[1].split(">", 1)[1].split("</voice>")[0].replace("<", " <").split())
        return va.make_wav(40 * max(1, len(content) // 3))  # 40 ms for every three characters, so durations are known

    def transcribe(self, wav: bytes, locales: list[str]) -> dict:
        return {"combinedPhrases": [{"text": "What time do you open?"}]}


class FakeLocal:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, float]] = []

    def status(self) -> dict:
        return {"installed": True, "running": False, "reason": "", "engine": "Kokoro-82M (ONNX)"}

    def synthesize(self, text: str, voice: str, speed: float) -> bytes:
        self.calls.append((text, voice, speed))
        return va.make_wav(500)

    def stop(self) -> None:
        pass


def reply_stream(*sentences: str, tag: str = "[neutral] ") -> Stream:
    pieces = [tag] + [s + " " for s in sentences]
    return Stream(pieces)


def service(script: list[Stream], rest: Any = "fake", local: Any = "fake", budget: float = 1.0, defaults: Any = None):
    clock = Clock()
    spend = SpendTracker(budget)
    svc = va.VoiceAgentService(FakeClaude(script), spend, FakeRest() if rest == "fake" else rest,
                               FakeLocal() if local == "fake" else local, clock=clock, autopoll=False, defaults=defaults)
    return svc, clock, spend


def say(svc: va.VoiceAgentService, clock: Clock, cid: str, words: str, silence: int = 700, resume: str | None = None) -> None:
    """A spoken turn: speech starts, text arrives, speech ends, then the clock runs on in 50 ms steps."""
    svc.handle(cid, {"type": "speech_start"})
    svc.handle(cid, {"type": "partial", "text": words})
    clock.t += 100
    svc.handle(cid, {"type": "speech_end"})
    for _ in range(silence // 50):
        clock.t += 50
        svc.poll(cid)


def kinds(events: list[dict], *types: str) -> list[str]:
    return [e["event"] if e["type"] == "turn_event" else e["type"] for e in events if e["type"] in types]


def live_threads() -> list[str]:
    return [t.name for t in threading.enumerate() if t.name.startswith("voice-agent-") and t.name != "voice-agent-clock"]


def settle(svc: va.VoiceAgentService, cid: str) -> None:
    assert svc.wait_idle(cid, 5), live_threads()


# ----------------------------------------------------------------------------------------------- turn detection

def test_a_finished_question_gives_start_eager_and_end() -> None:
    d = vtn.TurnDetector(vtn.TurnSettings(700, 0.6))
    out = d.speech_start(0) + d.partial_text("What time do you open?", 100) + d.speech_end(200)
    for now in range(250, 1200, 50):
        out += d.poll(now)
    assert [e.event for e in out] == ["StartOfTurn", "EagerEndOfTurn", "EndOfTurn"]
    eager, end = out[1], out[2]
    assert eager.silence_ms < end.silence_ms and end.text == "What time do you open?"


def test_an_unfinished_sentence_waits_longer_and_never_goes_eager() -> None:
    d = vtn.TurnDetector(vtn.TurnSettings(700, 0.6))
    out = d.speech_start(0) + d.partial_text("I want to ask about the", 100) + d.speech_end(100)
    ended_at = None
    for now in range(150, 3000, 50):
        for e in d.poll(now):
            out.append(e)
            ended_at = ended_at or now
    assert [e.event for e in out] == ["StartOfTurn", "EndOfTurn"]
    assert ended_at - 100 >= 700 * 1.6 - 50  # waited the longer time


def test_more_speech_after_an_eager_end_resumes_the_turn() -> None:
    d = vtn.TurnDetector(vtn.TurnSettings(700, 0.6))
    d.speech_start(0)
    d.partial_text("Is the shop open today?", 100)
    d.speech_end(150)
    eager = d.poll(400)
    assert [e.event for e in eager] == ["EagerEndOfTurn"]
    resumed = d.speech_start(450)
    assert [e.event for e in resumed] == ["TurnResumed"]
    assert d.partial_text("Is the shop open today? And on Sunday", 500) == []  # raised once, not for every word
    assert d.poll(520) == []  # voiced again, and no second eager end until the silence returns


def test_the_recognisers_late_final_is_not_new_speech() -> None:
    d = vtn.TurnDetector()
    d.speech_start(0)
    d.partial_text("what time do you open", 100)
    d.speech_end(150)
    assert [e.event for e in d.poll(300)] == ["EagerEndOfTurn"]
    assert d.final_text("What time do you open?", 320) == []  # same words: not a TurnResumed
    assert [e.event for e in d.poll(900)] == ["EndOfTurn"]
    assert d.final_text("What time do you open?", 950) == [] and not d.in_turn  # after the end: not a new turn


def test_a_number_being_read_out_is_not_finished() -> None:
    assert vtn.completeness("my card number is 4 1 1 1") < 0.4
    assert vtn.completeness("What time do you open?") > 0.9
    assert vtn.completeness("so I was thinking and") < 0.3


# ------------------------------------------------------------------------------------------------- the service

def test_a_spoken_turn_is_answered_with_audio_and_history() -> None:
    svc, clock, spend = service([reply_stream("We open at nine.", "Anything else?")])
    cid = svc.create()["id"]
    say(svc, clock, cid, "what time do you open")
    settle(svc, cid)
    events = svc.drain(cid)
    assert kinds(events, "turn_event") == ["StartOfTurn", "EagerEndOfTurn", "EndOfTurn"]
    audio = [e for e in events if e["type"] == "audio"]
    assert [a["text"] for a in audio] == ["We open at nine.", "Anything else?"]
    assert base64.b64decode(audio[0]["audio"])[:4] == b"RIFF" and audio[0]["duration_ms"] > 0
    assert kinds(events, "plan") == ["plan"] and "reply_done" in kinds(events, "reply_done")
    assert [h["role"] for h in svc.get(cid)["history"]] == ["user", "assistant"]
    assert spend.calls >= 3  # the model, and one charge for each piece spoken


def test_speculation_is_reused_when_the_turn_ends_on_the_same_words() -> None:
    svc, clock, _ = service([reply_stream("We open at nine.")])
    cid = svc.create()["id"]
    say(svc, clock, cid, "what time do you open")
    settle(svc, cid)
    events = svc.drain(cid)
    assert len(svc.claude.calls) == 1  # one model call served both the eager end and the end
    start = next(i for i, e in enumerate(events) if e["type"] == "turn_event" and e["event"] == "EagerEndOfTurn")
    end = next(i for i, e in enumerate(events) if e["type"] == "turn_event" and e["event"] == "EndOfTurn")
    first_audio = next(i for i, e in enumerate(events) if e["type"] == "audio")
    assert start < end < first_audio  # held until the turn ended
    assert next(e for e in events if e["type"] == "latency")["speculative_used"] is True


def test_turn_resumed_cancels_the_speculative_reply_and_nothing_is_spoken() -> None:
    gate = threading.Event()
    held = Stream(["[neutral] ", "We open at nine. ", "Anything else? "], gate=gate, hold_after=2)
    svc, clock, _ = service([held])
    cid = svc.create()["id"]
    svc.handle(cid, {"type": "speech_start"})
    svc.handle(cid, {"type": "partial", "text": "what time do you open"})
    svc.handle(cid, {"type": "speech_end"})
    clock.t += 200
    svc.poll(cid)  # eager: the model starts, its audio is held
    assert held.reached.wait(5)
    svc.handle(cid, {"type": "speech_start"})  # they carry on
    svc.handle(cid, {"type": "partial", "text": "what time do you open on Sundays"})
    gate.set()
    settle(svc, cid)
    events = svc.drain(cid)
    assert "TurnResumed" in kinds(events, "turn_event")
    cancelled = [e for e in events if e["type"] == "reply_cancelled"]
    assert len(cancelled) == 1 and cancelled[0]["speculative"] and cancelled[0]["reason"] == "turn_resumed"
    assert not [e for e in events if e["type"] in ("audio", "sentence", "plan")
                and e.get("speculative") is False]  # nothing was released to the page
    assert [e for e in events if e["type"] == "audio"] == []
    assert svc.get(cid)["history"] == [] and svc.get(cid)["wasted"]["replies"] == 1
    assert live_threads() == []


def test_a_changed_transcript_at_the_end_starts_a_fresh_reply() -> None:
    svc, clock, _ = service([reply_stream("Old answer."), reply_stream("New answer.")])
    cid = svc.create()["id"]
    svc.handle(cid, {"type": "speech_start"})
    svc.handle(cid, {"type": "partial", "text": "what time do you open"})
    svc.handle(cid, {"type": "speech_end"})
    clock.t += 200
    svc.poll(cid)
    svc.handle(cid, {"type": "final", "text": "What time do you close?", "audio_ms": 2000})  # the final differs
    clock.t += 800
    svc.poll(cid)
    settle(svc, cid)
    history = svc.get(cid)["history"]
    assert [h["text"] for h in history] == ["What time do you close?", "New answer."]


def test_barge_in_records_what_was_heard_from_the_playback_offset() -> None:
    svc, clock, _ = service([reply_stream("We open at nine on weekdays.", "Saturdays we open at ten."), reply_stream("Sure.")])
    cid = svc.create()["id"]
    say(svc, clock, cid, "what time do you open")
    settle(svc, cid)
    audio = [e for e in svc.drain(cid) if e["type"] == "audio"]
    first, second = audio[0]["duration_ms"], audio[1]["duration_ms"]
    played = first + second * 0.5  # the whole first piece and half of the second
    svc.handle(cid, {"type": "interrupt", "reply_id": audio[0]["reply_id"], "played_ms": played})
    entry = svc.get(cid)["history"][-1]
    assert entry["interrupted"] and entry["spoken"].startswith("We open at nine on weekdays.")
    assert entry["spoken"] != entry["text"] and entry["not_spoken"].endswith("at ten.")
    assert entry["method"] == "proportional"
    assert "Saturdays" in entry["spoken"] + entry["not_spoken"]
    # the next turn's model is told what was and was not heard
    say(svc, clock, cid, "wait I meant sundays please")
    settle(svc, cid)
    sent = svc.claude.calls[-1]["messages"]
    assistant = next(m["content"] for m in sent if m["role"] == "assistant")
    assert "interrupted" in assistant and "did not hear" in assistant and "We open at nine on weekdays." in assistant
    assert sent[0]["role"] == "user" and sent[-1]["role"] == "user"


def test_barge_in_while_the_model_is_still_writing_cancels_everything() -> None:
    gate = threading.Event()
    held = Stream(["[neutral] ", "Our opening hours are long, ", "so here is the full list of them. ", "More. "],
                  gate=gate, hold_after=2)
    svc, clock, _ = service([held])
    cid = svc.create()["id"]
    svc.text_turn(cid, "Tell me the opening hours")
    assert held.reached.wait(5)
    svc.handle(cid, {"type": "speech_start"})  # the caller speaks over the agent
    gate.set()
    settle(svc, cid)
    assert live_threads() == [] and held.closed
    events = svc.drain(cid)
    assert [e["reason"] for e in events if e["type"] == "reply_cancelled"] == ["barge_in"]
    entry = svc.get(cid)["history"][-1]
    assert entry["role"] == "assistant" and entry["interrupted"] and entry["generation_cut"]
    late = [e for e in events[[i for i, e in enumerate(events) if e["type"] == "reply_cancelled"][0]:]
            if e["type"] in ("audio", "sentence", "reply_done")]
    assert late == []  # nothing is emitted after a cancel


def test_closing_a_conversation_stops_its_reply_threads() -> None:
    gate = threading.Event()
    held = Stream(["[neutral] ", "Hello there, ", "this goes on. "], gate=gate, hold_after=2)
    svc, clock, _ = service([held])
    cid = svc.create()["id"]
    svc.text_turn(cid, "hello")
    assert held.reached.wait(5)
    svc.close(cid)
    gate.set()
    time.sleep(0.2)
    assert live_threads() == []
    with pytest.raises(ApiError) as e:
        svc.get(cid)
    assert e.value.status == 404


def test_an_error_part_way_keeps_the_history_consistent() -> None:
    boom = Stream(["[neutral] ", "We open at nine, ", "and "], error=RuntimeError("stream broke"))
    svc, clock, spend = service([boom, reply_stream("Back again.")])
    cid = svc.create()["id"]
    svc.text_turn(cid, "when do you open")
    settle(svc, cid)
    events = svc.drain(cid)
    assert [e["message"] for e in events if e["type"] == "error"]
    history = svc.get(cid)["history"]
    assert [h["role"] for h in history] == ["user", "assistant"] and history[1]["error"]
    assert "reply_done" in [e["type"] for e in events]
    svc.text_turn(cid, "try again")
    settle(svc, cid)
    sent = svc.claude.calls[-1]["messages"]
    assert [m["role"] for m in sent] == ["user", "assistant", "user"]
    assert "technical fault" in sent[1]["content"]
    assert spend.spent_usd > 0  # the failed stream was charged as an estimate


def test_an_error_before_any_text_leaves_only_the_callers_turn_and_the_next_turn_merges() -> None:
    svc, clock, _ = service([Stream([], error=RuntimeError("down")), reply_stream("Hello again.")])
    cid = svc.create()["id"]
    svc.text_turn(cid, "hello")
    settle(svc, cid)
    assert [h["role"] for h in svc.get(cid)["history"]] == ["user"]
    svc.text_turn(cid, "are you there")
    settle(svc, cid)
    sent = svc.claude.calls[-1]["messages"]
    assert [m["role"] for m in sent] == ["user"] and "hello" in sent[0]["content"] and "are you there" in sent[0]["content"]
    assert [h["role"] for h in svc.get(cid)["history"]] == ["user", "user", "assistant"]


def test_an_empty_reply_is_an_error_with_no_assistant_turn() -> None:
    svc, clock, _ = service([Stream(["[calm] "]), reply_stream("Fine now.")])
    cid = svc.create()["id"]
    svc.text_turn(cid, "hello")
    settle(svc, cid)
    assert any(e["type"] == "error" for e in svc.drain(cid))
    assert [h["role"] for h in svc.get(cid)["history"]] == ["user"]
    svc.text_turn(cid, "hello again")
    settle(svc, cid)
    assert [m["role"] for m in svc.claude.calls[-1]["messages"]] == ["user"]


def test_a_speech_error_keeps_what_was_generated_and_only_sent_pieces_count_as_heard() -> None:
    rest = FakeRest()
    rest.fail_on = 2
    svc, clock, _ = service([reply_stream("First sentence here.", "Second sentence here.")], rest=rest)
    cid = svc.create()["id"]
    svc.text_turn(cid, "go on")
    settle(svc, cid)
    entry = svc.get(cid)["history"][-1]
    assert entry["error"] and entry["spoken"] == "First sentence here." and "Second" in entry["not_spoken"]


def test_two_turns_at_once_on_one_conversation_leave_one_live_reply_and_a_consistent_history() -> None:
    script = [Stream(["[neutral] ", "Answer one, ", "it is long. "]), Stream(["[neutral] ", "Answer two, ", "it is long. "])]
    svc, clock, _ = service(script)
    cid = svc.create()["id"]
    barrier = threading.Barrier(2)

    def go(message: str) -> None:
        barrier.wait()
        svc.text_turn(cid, message)

    threads = [threading.Thread(target=go, args=(m,)) for m in ("first question", "second question")]
    [t.start() for t in threads]
    [t.join() for t in threads]
    settle(svc, cid)
    history = svc.get(cid)["history"]
    users = [h for h in history if h["role"] == "user"]
    assert len(users) == 2
    done = [e for e in svc.drain(cid) if e["type"] == "reply_done"]
    assert len(done) >= 1 and live_threads() == []
    sent = svc.claude.calls[-1]["messages"]
    assert sent[0]["role"] == "user" and sent[-1]["role"] == "user"
    assert all(a["role"] != b["role"] for a, b in zip(sent, sent[1:]))


def test_two_conversations_do_not_share_history_or_events() -> None:
    svc, clock, _ = service([reply_stream("Reply for A."), reply_stream("Reply for B.")])
    a, b = svc.create()["id"], svc.create()["id"]
    svc.text_turn(a, "question A")
    settle(svc, a)
    svc.text_turn(b, "question B")
    settle(svc, b)
    assert [h["text"] for h in svc.get(a)["history"]] == ["question A", "Reply for A."]
    assert [h["text"] for h in svc.get(b)["history"]] == ["question B", "Reply for B."]
    assert all("B" not in e.get("text", "") for e in svc.drain(a) if e["type"] in ("sentence", "audio"))


def test_only_one_listener_per_conversation() -> None:
    svc, _, _ = service([])
    cid = svc.create()["id"]
    s = svc.claim(cid)
    with pytest.raises(ApiError) as e:
        svc.claim(cid)
    assert e.value.status == 409
    svc.release(s)
    svc.claim(cid)


def test_the_local_voice_is_used_when_chosen_and_gets_a_speed_from_the_plan() -> None:
    svc, clock, _ = service([reply_stream("Calm now.", tag="[calm] ")])
    cid = svc.create({"tts": "local", "expressiveness": 2})["id"]
    svc.text_turn(cid, "I am really worried about this")
    settle(svc, cid)
    local = svc.local
    assert svc.rest.ssml == [] and local.calls and local.calls[0][1] == "bf_emma" and local.calls[0][2] < 1.0


def test_without_azure_the_reply_reports_the_problem_and_keeps_its_text() -> None:
    svc, clock, _ = service([reply_stream("Hello there.")], rest=None)
    cid = svc.create()["id"]
    svc.text_turn(cid, "hi")
    settle(svc, cid)
    events = svc.drain(cid)
    assert any("AZURE_LANGUAGE_ENDPOINT" in e.get("message", "") for e in events if e["type"] == "error")
    assert svc.get(cid)["history"][-1]["text"] == "Hello there."


def test_the_spending_cap_stops_a_turn() -> None:
    svc, clock, spend = service([reply_stream("Never said.")], budget=0.0)
    cid = svc.create()["id"]
    svc.text_turn(cid, "hi")
    settle(svc, cid)
    assert svc.claude.calls == []
    assert any("spending cap" in e.get("message", "") for e in svc.drain(cid) if e["type"] == "error")


def test_latency_marks_and_running_stats() -> None:
    svc, clock, _ = service([reply_stream("One."), reply_stream("Two.")])
    cid = svc.create()["id"]
    for words in ("what time do you open", "what time do you close"):
        say(svc, clock, cid, words)
        settle(svc, cid)
        reply_id = [e for e in svc.drain(cid) if e["type"] == "audio"][0]["reply_id"]
        clock.t += 120
        svc.handle(cid, {"type": "playback", "reply_id": reply_id, "state": "started"})
    stats = svc.get(cid)["latency"]
    assert stats["turns"] == 2 and stats["median_ms"] is not None and stats["p95_ms"] >= stats["median_ms"]
    row = svc.sessions[cid].latency[2]
    assert row["first_audio_played"] >= row["first_audio_sent"] >= row["end_of_turn"] - 0 and row["first_token"] is not None


def test_percentile_is_nearest_rank() -> None:
    assert va.percentile([], 50) is None
    assert va.percentile([10, 20, 30, 40], 50) == 20 and va.percentile([10, 20, 30, 40], 95) == 40
    assert va.percentile(list(range(1, 101)), 95) == 95


# ---------------------------------------------------------------------------------------------------- heard text

def test_split_heard_whole_pieces_then_words() -> None:
    pieces = [voice_heard.Piece("One two three.", 1000), voice_heard.Piece("Four five six seven.", 2000), voice_heard.Piece("Eight.", 500)]
    h = voice_heard.split_heard(pieces, 1000)
    assert (h.spoken, h.not_spoken) == ("One two three.", "Four five six seven. Eight.")
    h = voice_heard.split_heard(pieces, 1400)
    assert h.spoken.startswith("One two three. Four") and h.not_spoken.endswith("Eight.") and h.method == "proportional"
    assert voice_heard.split_heard(pieces, 99999).not_spoken == "" and voice_heard.split_heard(pieces, 0).spoken == ""


def test_split_heard_uses_word_boundaries_when_the_voice_gives_them() -> None:
    piece = voice_heard.Piece("alpha beta gamma delta", 4000, word_ends_ms=[100, 3000, 3500, 4000])
    h = voice_heard.split_heard([piece], 1500)
    assert h.spoken == "alpha" and h.method == "boundaries"  # beta runs long: proportional would have said two words


def test_text_never_synthesised_is_not_heard() -> None:
    pieces = [voice_heard.Piece("Said.", 500), voice_heard.Piece("Never made into audio.", 0)]
    h = voice_heard.split_heard(pieces, 5000)
    assert h.spoken == "Said." and h.not_spoken == "Never made into audio."
    assert voice_heard.split_heard(pieces, None, sent=1).method == "sent"


# ----------------------------------------------------------------------------------------------------- normaliser

@pytest.mark.parametrize("before, after", [
    ("4111 1111 1111 1111", "four one one one, one one one one, one one one one, one one one one"),
    ("4111-1111-1111-1111", "four one one one, one one one one, one one one one, one one one one"),
    ("020 7946 0958", "oh two oh, seven nine four six, oh nine five eight"),
    ("07700 900123", "oh seven seven oh oh, nine oh oh, one two three"),
    ("+44 20 7946 0958", "plus four four, two oh, seven nine four six, oh nine five eight"),
    ("0800 123 4567", "oh eight oh oh, one two three, four five six seven"),
    ("£1,234.56", "one thousand, two hundred and thirty-four pounds fifty-six"),
    ("£5", "five pounds"), ("£1", "one pound"), ("£1.20", "one pound twenty"), ("£0.50", "fifty pence"), ("50p", "fifty pence"),
    ("£2.5m", "two point five million pounds"),
    ("12.5%", "twelve point five percent"), ("100%", "one hundred percent"),
    ("15/03/2025", "the fifteenth of March twenty twenty-five"),
    ("2025-12-01", "the first of December twenty twenty-five"),
    ("3 March 2005", "the third of March two thousand and five"),
    ("14:30", "two thirty p m"), ("09:05", "nine oh five a m"), ("3pm", "three p m"), ("00:15", "twelve fifteen a m"),
    ("SW1A 1AA", "S W one A, one A A"),
    ("AB12-3456", "A B one two, three four five six"),
    ("12-34-56", "one two, three four, five six"),
    ("order 55821", "order five five eight, two one"),
    ("account number 12345678", "account number one two three four, five six seven eight"),
    ("1,200 users", "one thousand, two hundred users"), ("3.14", "three point one four"), ("in 1999", "in nineteen ninety-nine"),
    ("5km", "five kilometres"), ("1st May", "the first of May"),
    ("No numbers here.", "No numbers here."),
])
def test_the_normaliser_reads_numbers_the_way_people_say_them(before: str, after: str) -> None:
    assert vt.normalise(before) == after


def test_the_normaliser_works_inside_sentences_and_marks_what_changed() -> None:
    text = "Your card 4111 1111 1111 1111 expires 03/27, and you owe £5.50 by 2025-12-01."
    out = vt.normalise(text)
    assert "expires oh three, twenty-seven," in out and "five pounds fifty" in out and "the first of December" in out
    kinds_found = {s.kind for s in vt.explain(text)}
    assert {"card number", "card expiry", "money", "date", "text"} <= kinds_found
    assert "".join(s.before for s in vt.explain(text)) == text  # nothing lost or added in the before column


def test_number_words() -> None:
    assert [vt.number_words(n) for n in (0, 13, 21, 100, 101, 999, 1000, 1001, 2_000_000)] == [
        "zero", "thirteen", "twenty-one", "one hundred", "one hundred and one", "nine hundred and ninety-nine",
        "one thousand", "one thousand and one", "two million"]
    assert vt.ordinal_words(21) == "twenty-first" and vt.ordinal_words(12) == "twelfth" and vt.ordinal_words(30) == "thirtieth"


def test_the_chunker_starts_at_the_first_clause_and_ends_at_sentences() -> None:
    c = vt.Chunker()
    out: list[str] = []
    for delta in ["Yes, I can ", "help with that for you, Mr. ", "Smith. Your total is £3.", "50 today. ", "Anything else"]:
        out += c.feed(delta)
    out += c.flush()
    assert out == ["Yes, I can help with that for you,", "Mr. Smith.", "Your total is £3.50 today.", "Anything else"]


# ------------------------------------------------------------------------------------------------------- prosody

def test_prosody_plan_validation() -> None:
    assert vp.validate({"tag": "calm", "rate": -10, "pitch": -3, "pause_ms": 400}) == {"tag": "calm", "rate": -10, "pitch": -3, "pause_ms": 400}
    for bad in ({"tag": "angry"}, {"tag": "calm", "rate": 90}, {"tag": "calm", "pitch": "high"}, {"tag": "calm", "pause_ms": -1},
                {"tag": "calm", "rate": True}, "calm", None):
        with pytest.raises(vp.PlanError):
            vp.validate(bad)
    with pytest.raises(vp.PlanError):
        vp.build_plan("furious", "en-GB-SoniaNeural", 2)


def test_expressiveness_scales_the_plan_and_off_is_the_plain_voice() -> None:
    off = vp.build_plan("calm", "en-US-AriaNeural", 0)
    assert (off.rate, off.pitch, off.style, off.pause_ms) == (0, 0, None, 200)
    medium, strong = vp.build_plan("calm", "en-US-AriaNeural", 2), vp.build_plan("calm", "en-US-AriaNeural", 3)
    assert medium.rate == -10 and strong.rate < medium.rate and strong.degree > medium.degree and medium.style == "calm" or medium.style
    assert vp.build_plan("calm", "en-GB-SoniaNeural", 2).style is None  # Sonia has no calm style: numbers only
    assert vp.build_plan("cheerful", "en-GB-SoniaNeural", 2).style == "cheerful"


def test_ssml_is_escaped_and_uses_only_the_voice_styles() -> None:
    plan = vp.build_plan("cheerful", "en-GB-SoniaNeural", 2)
    ssml = vp.build_ssml("Tom & Jerry <3 said \"hi\"", "en-GB-SoniaNeural", plan)
    assert "Tom &amp; Jerry &lt;3" in ssml and '<mstts:express-as style="cheerful"' in ssml and 'xml:lang="en-GB"' in ssml
    plain_plan = vp.build_plan("neutral", "en-GB-SoniaNeural", 2)
    assert "express-as" not in vp.build_ssml("Hello", "en-GB-SoniaNeural", plain_plan)


def test_the_model_tag_is_parsed_from_the_start_of_the_reply() -> None:
    assert vp.parse_tag("[calm] I am sorry") == ("calm", "I am sorry", True)
    assert vp.parse_tag("[cal") == (None, "", False)
    assert vp.parse_tag("[nonsense] hi") == (None, "hi", True)
    assert vp.parse_tag("No tag here") == (None, "No tag here", True)


def test_rules_override_a_cheerful_model_for_an_upset_caller_and_the_mood_carries() -> None:
    mood = vp.Mood()
    assert mood.choose("This is RIDICULOUS, I am furious about my parcel", "cheerful")[:2] == ("calm", "rules")
    tag, source, _ = mood.choose("ok thanks, what time does it arrive?", "brisk")
    assert (tag, source) == ("calm", "carried")  # still easing off
    mood.choose("and the day after?", "neutral")
    assert mood.choose("great, what is the postcode?", "brisk")[0] == "brisk"
    assert vp.rule_tag("What time do you open?")[0] == "brisk" and vp.rule_tag("I was telling you about my garden")[0] == "neutral"


# --------------------------------------------------------------------------------------------------------- routes

def make_app(tmp_path: Path, budget: float = 2.0, script: list[Stream] | None = None):
    settings = Settings(port=8000, budget_usd=budget, frontend_dist=tmp_path / "dist", models_dir=tmp_path / "no-models",
                        generated_dir=tmp_path / "generated")
    app = create_app(settings, client=FakeClient())
    clock = Clock()
    svc = va.VoiceAgentService(FakeClaude(script or []), app.state.container.spend, FakeRest(), FakeLocal(), clock=clock,
                               autopoll=False, heartbeat_s=0.2)
    object.__setattr__(app.state.container, "voice_agent", svc)
    return TestClient(app, base_url="http://localhost:8000"), svc


def test_routes_are_guarded_like_every_lab_page(tmp_path: Path) -> None:
    client, _ = make_app(tmp_path)
    for headers in ({"host": "localhost:8000"}, {"x-llm-lab": "1", "host": "evil.example:8000"},
                    {"x-llm-lab": "1", "host": "localhost:8000", "origin": "https://evil.example"}):
        assert client.get("/api/voice-agent/info", headers=headers).status_code == 403
        assert client.post("/api/voice-agent/conversations", json={}, headers=headers).status_code == 403
        assert client.post("/api/voice-agent/normalise", json={"text": "5"}, headers=headers).status_code == 403
    assert client.get("/api/voice-agent/info", headers=LAB).status_code == 200


def test_paid_routes_need_budget_and_free_ones_do_not(tmp_path: Path) -> None:
    client, svc = make_app(tmp_path, budget=0)
    cid = svc.create()["id"]
    for path, body in ((f"/conversations/{cid}/input", {"type": "speech_start"}), (f"/conversations/{cid}/text", {"text": "hi"}),
                       ("/speak", {"text": "hi"})):
        r = client.post(f"/api/voice-agent{path}", json=body, headers=LAB)
        assert r.status_code == 429 and r.json()["error"]["type"] == "budget_exceeded", path
    assert client.get("/api/voice-agent/info", headers=LAB).status_code == 200
    assert client.post("/api/voice-agent/normalise", json={"text": "£5"}, headers=LAB).json()["after"] == "five pounds"
    assert client.get(f"/api/voice-agent/conversations/{cid}", headers=LAB).status_code == 200
    assert client.delete(f"/api/voice-agent/conversations/{cid}", headers=LAB).status_code == 200


@pytest.mark.parametrize("path, body", [
    ("/conversations", {"end_silence_ms": 50}), ("/conversations", {"end_silence_ms": 9000}),
    ("/conversations", {"eager_threshold": 0.1}), ("/conversations", {"expressiveness": 9}), ("/conversations", {"tts": "other"}),
    ("/conversations", {"model": "x" * 200}),
])
def test_settings_are_validated(tmp_path: Path, path: str, body: dict) -> None:
    client, _ = make_app(tmp_path)
    r = client.post(f"/api/voice-agent{path}", json=body, headers=LAB)
    assert r.status_code == 400 and r.json()["error"]["type"] == "invalid_request"


def test_unknown_voice_and_model_are_refused_by_the_service(tmp_path: Path) -> None:
    client, _ = make_app(tmp_path)
    for body in ({"voice": "en-GB-Nobody"}, {"model": "gpt-4"}, {"local_voice": "xx"}):
        r = client.post("/api/voice-agent/conversations", json=body, headers=LAB)
        assert r.status_code == 422 and r.json()["error"]["type"] == "invalid_setting"


def test_input_validation(tmp_path: Path) -> None:
    client, svc = make_app(tmp_path)
    cid = svc.create()["id"]
    url = f"/api/voice-agent/conversations/{cid}/input"
    bad = [{"type": "nonsense"}, {"type": "partial"}, {"type": "partial", "text": ""}, {"type": "partial", "text": "x" * 1001},
           {"type": "final", "text": "ok", "audio_ms": -1}, {"type": "final", "text": "ok", "audio_ms": 10**9},
           {"type": "interrupt", "reply_id": "r1", "played_ms": -5}, {"type": "interrupt", "reply_id": "../x", "played_ms": 5},
           {"type": "interrupt", "reply_id": "r1", "played_ms": 10**9}, {"type": "playback", "reply_id": "r1", "state": "paused"}]
    for body in bad:
        assert client.post(url, json=body, headers=LAB).status_code == 400, body
    assert client.post(f"/api/voice-agent/conversations/{cid}/text", json={"text": "x" * 1001}, headers=LAB).status_code == 400
    assert client.post("/api/voice-agent/conversations/not-an-id/text", json={"text": "hi"}, headers=LAB).status_code == 400
    r = client.post("/api/voice-agent/conversations/aaaaaaaaaaaa/text", json={"text": "hi"}, headers=LAB)
    assert r.status_code == 404
    assert client.post(url, json={"type": "interrupt", "reply_id": "r9", "played_ms": 5}, headers=LAB).json() == {"ok": False}


def test_speak_and_normalise_routes(tmp_path: Path) -> None:
    client, svc = make_app(tmp_path)
    r = client.post("/api/voice-agent/speak", json={"text": "Call 020 7946 0958", "tts": "azure"}, headers=LAB)
    body = r.json()
    assert r.status_code == 200 and body["spoken_as"] == "Call oh two oh, seven nine four six, oh nine five eight"
    assert base64.b64decode(body["audio"])[:4] == b"RIFF" and "oh two oh" in svc.rest.ssml[0]
    assert client.post("/api/voice-agent/speak", json={"text": "x" * 401}, headers=LAB).status_code == 400
    local = client.post("/api/voice-agent/speak", json={"text": "Hi", "tts": "local"}, headers=LAB).json()
    assert local["tts"] == "local" and svc.local.calls
    seg = client.post("/api/voice-agent/normalise", json={"text": "Pay £5 on 3 March."}, headers=LAB).json()
    assert seg["after"] == "Pay five pounds on the third of March." and {s["kind"] for s in seg["segments"]} >= {"money", "date"}


def test_audio_upload_is_checked_then_transcribed_and_answered(tmp_path: Path) -> None:
    client, svc = make_app(tmp_path, script=[reply_stream("We open at nine.")])
    cid = svc.create()["id"]
    url = f"/api/voice-agent/conversations/{cid}/audio"
    assert client.post(url, files={"file": ("a.wav", b"not a wav", "audio/wav")}, headers=LAB).status_code == 422
    assert client.post(url, files={"file": ("a.wav", va.make_wav(100), "audio/wav")}, headers=LAB).status_code == 422  # too short
    assert client.post(url, files={"file": ("a.wav", va.make_wav(40_000), "audio/wav")}, headers=LAB).status_code == 422  # too long
    ok = client.post(url, files={"file": ("a.wav", va.make_wav(2000), "audio/wav")}, headers=LAB)
    assert ok.status_code == 200 and ok.json()["text"] == "What time do you open?"
    settle(svc, cid)
    assert [h["role"] for h in svc.get(cid)["history"]] == ["user", "assistant"]


def test_the_event_stream_has_one_listener_and_ends_when_the_conversation_closes(tmp_path: Path) -> None:
    client, svc = make_app(tmp_path)
    cid = svc.create()["id"]
    threading.Timer(0.4, svc.close, args=(cid,)).start()
    lines = []
    with client.stream("POST", f"/api/voice-agent/conversations/{cid}/events", headers=LAB) as r:
        assert r.status_code == 200
        lines = [json.loads(line) for line in r.iter_lines() if line.strip()]
    assert [e["type"] for e in lines] == ["ready", "closed"]


def test_conversations_are_capped_and_the_idle_one_is_evicted() -> None:
    svc, _, _ = service([])
    svc.max_conversations = 2
    a = svc.create()["id"]
    b = svc.create()["id"]
    svc.claim(b)  # b is being listened to
    svc.create()
    assert a not in svc.sessions and b in svc.sessions
    svc.claim(next(i for i in svc.sessions if i != b))
    with pytest.raises(ApiError) as e:
        svc.create()
    assert e.value.status == 429


def test_the_wav_check() -> None:
    assert va.check_wav(va.make_wav(1000)) == pytest.approx(1.0)
    with pytest.raises(ApiError):
        va.check_wav(b"x" * (va.MAX_AUDIO_BYTES + 1))


def test_system_prompt_is_grounded_in_the_handbook():
    """Policy answers come from the handbook, so a figure such as the meal limit is never invented."""
    from backend.app.services import voice_agent as va

    assert "£35 per day" in va.SYSTEM  # the meals limit, from python/data.py
    assert "Never invent a policy figure" in va.SYSTEM
    assert "make up a plausible example" in va.SYSTEM  # still allowed, only for personal details it cannot see


def test_the_local_voice_is_not_probed_or_restarted_before_every_sentence(tmp_path, monkeypatch):
    """Once started, a busy server must not fail a health probe and be killed mid-reply."""
    import io

    from backend.app.gateways import local_tts

    tts = local_tts.LocalTts(tmp_path, tmp_path, 1)

    class Alive:
        def poll(self):
            return None

    monkeypatch.setattr(tts, "_process", Alive())  # restored to None afterwards, so the exit hook stops nothing
    tts._ready = True
    probes, stops = [], []
    monkeypatch.setattr(tts, "_healthy", lambda: probes.append(1) or False)  # as if busy: the probe would time out
    monkeypatch.setattr(tts, "stop", lambda: stops.append(1))
    monkeypatch.setattr(local_tts.urllib.request, "urlopen", lambda *a, **k: io.BytesIO(b"RIFFwav"))
    assert tts.synthesize("One.", "af_heart", 1.0) == b"RIFFwav"
    assert tts.synthesize("Two.", "af_heart", 1.0) == b"RIFFwav"
    assert probes == [] and stops == []


def test_a_listener_that_never_polled_can_be_taken_over() -> None:
    """A client that left before its stream started never releases; after LISTENER_STALE_S the claim can be taken."""
    svc, clock, _ = service([])
    cid = svc.create()["id"]
    first = svc.claim(cid)
    old = first.listener_token
    with pytest.raises(ApiError):
        svc.claim(cid)
    clock.t += 5_000  # still fresh: refused
    with pytest.raises(ApiError):
        svc.claim(cid)
    clock.t += va.LISTENER_STALE_S * 1000  # the clock counts milliseconds
    second = svc.claim(cid)
    svc.release(second, old)  # the old stream ending must not release the new claim
    assert second.listener and second.listener_token != old


def test_an_event_taken_by_a_cancelled_wait_is_not_lost() -> None:
    """The page goes while the stream waits for an event: an event emitted after that stays for the next listener."""
    import asyncio

    from backend.app.api import voice_agent as route

    svc, _, _ = service([])
    cid = svc.create()["id"]
    s = svc.claim(cid)
    svc.drain(cid)  # the 'ready' event

    async def scenario() -> None:
        waiting = asyncio.ensure_future(route.next_event(svc, s, 1.0))
        await asyncio.sleep(0.1)  # the stream is now waiting
        waiting.cancel()
        s.emit({"type": "reply_done", "n": 7})  # arrives after the page went
        with pytest.raises(asyncio.CancelledError):
            await waiting
        await asyncio.sleep(0.2)

    asyncio.run(scenario())
    got = svc.next_event(s, 0.1)
    assert got is not None and (got["type"], got["n"]) == ("reply_done", 7)


def test_a_default_from_the_environment_that_would_be_refused_falls_back() -> None:
    """VOICE_AGENT_VOICE set to a voice not in the table must not make every conversation fail with 422."""
    svc, _, _ = service([], defaults=va.ConvSettings(voice="en-GB-LibbyNeural", end_silence_ms=900))
    assert svc.defaults.voice == va.ConvSettings().voice and svc.defaults.end_silence_ms == 900
    cid = svc.create(svc.info()["defaults"])["id"]  # what the page does: send the defaults back
    assert svc.get(cid)["settings"]["voice"] == va.ConvSettings().voice


def test_the_verb_may_after_a_number_is_not_read_as_a_month() -> None:
    from backend.app.services.voice_text import normalise

    said = normalise("Up to 5 may be carried over.")
    assert "of May" not in said and "may be carried over" in said
    assert "the fifteenth of May twenty twenty-six" in normalise("It starts on 15 May 2026.")


def test_a_short_answer_inside_the_last_turns_words_is_new_speech() -> None:
    """'no' is a substring of 'I do not know', but it is the caller answering, not the recogniser repeating."""
    d = vtn.TurnDetector(vtn.TurnSettings(700, 0.6))
    d.speech_start(0)
    d.partial_text("I do not know", 100)
    d.speech_end(150)
    out = []
    for now in range(200, 2500, 50):
        out += d.poll(now)
    assert out[-1].event == "EndOfTurn"
    assert d.partial_text("I do not know", 2600) == []  # a late repeat of the same words is still ignored
    # Text alone (no voice-activity start, which raises StartOfTurn whatever the words) is the path the check guards.
    assert [e.event for e in d.partial_text("no", 2750)] == ["StartOfTurn"]


def test_a_short_statement_with_a_number_is_not_treated_as_a_quick_question() -> None:
    from backend.app.services.voice_prosody import rule_tag

    assert rule_tag("My card number is 4111")[0] == "neutral"
    assert rule_tag("It was 3 days ago.")[0] == "neutral"
    assert rule_tag("What time do you open?")[0] == "brisk"
    assert rule_tag("Is extension 4400 right?")[0] == "brisk"


# ----- review findings, second pass -----

def test_an_open_event_stream_holds_no_worker_thread(monkeypatch) -> None:
    """Each listener used to keep a default-executor thread blocked on the queue, so a few open pages filled the pool that
    audio uploads need. The wait is now on the event loop, woken by the thread that emits."""
    import asyncio

    from backend.app.api import voice_agent as route

    svc, _, _ = service([])
    cid = svc.create()["id"]
    s = svc.claim(cid)
    svc.drain(cid)

    def no_threads(*a, **k):
        raise AssertionError("the event stream must not take a worker thread")

    monkeypatch.setattr(route.asyncio, "to_thread", no_threads)

    async def scenario() -> tuple[dict | None, float, dict | None]:
        threading.Timer(0.05, lambda: s.emit({"type": "reply_done", "n": 1})).start()  # emitted from another thread
        started = time.monotonic()
        got = await route.next_event(svc, s, 5.0)
        took = time.monotonic() - started
        return got, took, await route.next_event(svc, s, 0.05)

    got, took, nothing = asyncio.run(scenario())
    assert got is not None and got["n"] == 1 and took < 1.0  # woken at once, not at the timeout
    assert nothing is None and not s.wakers  # a timed-out wait leaves no waker behind


def test_a_recording_sent_while_the_microphone_has_a_turn_open_ends_that_turn() -> None:
    """It used to start a second turn under the live turn's next number while the detector still had the live one
    open, so the turn marks and latency rows of the two collided."""
    svc, clock, _ = service([reply_stream("We open at nine.")])
    cid = svc.create()["id"]
    svc.handle(cid, {"type": "speech_start"})
    svc.handle(cid, {"type": "partial", "text": "what time"})
    s = svc._get(cid)
    live = s.detector.turn
    assert s.detector.in_turn
    clock.t += 100
    assert svc.audio_turn(cid, va.make_wav(1000))["text"] == "What time do you open?"
    settle(svc, cid)
    turn_events = [e for e in svc.drain(cid) if e["type"] == "turn_event"]
    assert [e["event"] for e in turn_events].count("StartOfTurn") == 1
    assert {e["turn"] for e in turn_events} == {live} and not s.detector.in_turn
    assert svc.get(cid)["history"][-1]["role"] == "assistant"


def test_the_local_voice_will_not_use_another_program_on_its_port(tmp_path, monkeypatch) -> None:
    """Something already answering on the port (another program, a server left from an earlier run) was taken for the
    new server, which had failed to bind: text went to the wrong process and every call restarted it."""
    from backend.app.gateways import local_tts

    (tmp_path / ".venv" / "bin").mkdir(parents=True)
    (tmp_path / ".venv" / "bin" / "python").write_text("")
    for name in local_tts.MODEL_FILES:
        (tmp_path / name).write_text("")
    tts = local_tts.LocalTts(tmp_path, tmp_path, 1)
    started = []
    monkeypatch.setattr(local_tts.subprocess, "Popen", lambda *a, **k: started.append(a) or None)
    monkeypatch.setattr(tts, "_answering_pid", lambda: 4321)  # a stranger answers
    with pytest.raises(local_tts.LocalTtsError, match="already answering"):
        tts.synthesize("Hello.", "af_heart", 1.0)
    assert started == []

    class Child:
        pid = 1234

        def poll(self):
            return None

    monkeypatch.setattr(tts, "_process", Child())
    assert not tts._healthy()  # someone answers, but not our child
    monkeypatch.setattr(tts, "_answering_pid", lambda: 1234)
    assert tts._healthy()
    monkeypatch.setattr(tts, "_process", None)


def test_a_request_that_races_close_starts_no_reply() -> None:
    """A turn that found the conversation open just before it was closed used to start reply threads nothing cancels."""
    svc, _, spend = service([reply_stream("Never said.")])
    cid = svc.create()["id"]
    s = svc._get(cid)  # the request has the session...
    svc.close(cid)  # ...and then the page closes it
    with pytest.raises(ApiError) as caught:
        svc._whole_turn(s, "hello", 0, 0, {})
    assert caught.value.status == 404 and s.jobs == [] and not live_threads() and spend.spent_usd == 0


def test_an_idle_conversation_is_closed_after_the_idle_time() -> None:
    svc, clock, _ = service([])
    old, fresh = svc.create()["id"], None
    clock.t += va.LISTEN_IDLE_S * 1000 - 1000
    fresh = svc.create()["id"]
    clock.t += 2000
    assert svc.expire_idle() == [old]
    with pytest.raises(ApiError):
        svc.get(old)
    assert svc.get(fresh)["id"] == fresh
