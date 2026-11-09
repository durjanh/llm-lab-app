using MedAssist.Application;
using MedAssist.Domain;
using MedAssist.Testing;
using Microsoft.Extensions.Options;

namespace MedAssist.Application.Tests;

/// <summary>The portal's conversations, with a scripted engine and a throwaway database: no Azure.</summary>
public class ChatServiceTests
{
    private TempPractice _practice = null!;
    private FakeEngine _engine = null!;
    private PricingOptions _pricing = null!;
    private ChatService _chats = null!;

    [SetUp]
    public void Build()
    {
        _practice = new TempPractice();
        _engine = new FakeEngine();
        _pricing = new PricingOptions { Models = { ["fake-model"] = new ModelPrice { Input = 1m, Output = 10m } } };
        var spend = new SpendTracker(Options.Create(_pricing), _practice.OptionsWrapper);
        _chats = new ChatService(_engine, _practice.Practice, spend, _practice.OptionsWrapper);
    }

    [TearDown]
    public void Clean() => _practice.Dispose();

    [Test]
    public async Task A_conversation_starts_for_the_signed_in_patient_and_shows_their_records()
    {
        var started = await _chats.StartAsync("P001");

        started.ChatId.Should().NotBeNullOrEmpty();
        started.State.Patient.Name.Should().Be("Valeria Romano");
        started.State.Upcoming.Should().ContainSingle(a => a.Reason == "Annual asthma review");
        _engine.Started.Should().Equal("P001");
    }

    [Test]
    public async Task A_reply_is_priced_by_the_engines_model_and_added_to_the_conversations_total()
    {
        var chat = await _chats.StartAsync("P002");

        var first = await _chats.SendAsync(chat.ChatId, "hello");
        var second = await _chats.SendAsync(chat.ChatId, "again");

        first.Reply.Should().Be("You said: hello");
        first.CostUsd.Should().Be(0.002m);  // 1,000 input at $1/M + 100 output at $10/M
        second.TotalUsd.Should().Be(0.004m);
    }

    [Test]
    public async Task Each_message_is_a_new_turn_for_the_rules()
    {
        var turns = new List<int>();
        _engine.Reply = (session, text) =>
        {
            turns.Add(session.Turn);
            return new TurnResult("ok", [], TokenUsage.None);
        };
        var chat = await _chats.StartAsync("P002");

        await _chats.SendAsync(chat.ChatId, "one");
        await _chats.SendAsync(chat.ChatId, "two");

        turns.Should().Equal(1, 2);
    }

    [Test]
    public async Task What_the_tools_change_is_in_the_state_returned_with_the_reply()
    {
        _engine.Reply = (session, text) =>
        {
            var slot = ((FreeSlots)session.FindAppointments(new("gp", "", "", "any"))).Slots[0].SlotId;
            session.NextTurn();
            var booked = session.BookAppointment(new(slot, text));
            return new TurnResult("Booked.", [new FunctionStep("book_appointment", "{}", booked)], TokenUsage.None);
        };
        var chat = await _chats.StartAsync("P002");

        var reply = await _chats.SendAsync(chat.ChatId, "review");

        reply.Steps.Should().ContainSingle().Which.Should().BeOfType<FunctionStep>();
        reply.State.Upcoming.Should().Contain(a => a.Reason == "review");
        reply.State.Texts.Should().ContainSingle();
    }

    [Test]
    public async Task An_ended_or_unknown_conversation_is_not_found()
    {
        var chat = await _chats.StartAsync("P002");
        (await _chats.EndAsync(chat.ChatId)).Should().BeTrue();

        var send = () => _chats.SendAsync(chat.ChatId, "hello");
        (await send.Should().ThrowAsync<ServiceException>()).Which.Kind.Should().Be(FailureKind.NotFound);
        _engine.Ended.Should().Be(1);
    }

    [Test]
    public async Task The_oldest_conversation_ends_when_there_are_too_many()
    {
        var first = await _chats.StartAsync("P001");  // MaxConversations is 2 in TempPractice
        await _chats.StartAsync("P002");
        await _chats.StartAsync("P003");

        _engine.Ended.Should().Be(1);
        var send = () => _chats.SendAsync(first.ChatId, "still there?");
        await send.Should().ThrowAsync<ServiceException>();
    }

    [Test]
    public async Task Nothing_more_is_spent_once_the_budget_is_reached()
    {
        _engine.Reply = (_, _) => new TurnResult("expensive", [], new TokenUsage(1_000_000, 0, 0));  // $1, the whole budget
        var chat = await _chats.StartAsync("P002");
        await _chats.SendAsync(chat.ChatId, "hello");

        var again = () => _chats.SendAsync(chat.ChatId, "hello");
        (await again.Should().ThrowAsync<ServiceException>()).Which.Kind.Should().Be(FailureKind.BudgetExceeded);
    }

    [Test]
    public async Task An_empty_message_is_refused_before_the_engine_sees_it()
    {
        var chat = await _chats.StartAsync("P002");
        var send = () => _chats.SendAsync(chat.ChatId, "   ");
        (await send.Should().ThrowAsync<ServiceException>()).Which.Kind.Should().Be(FailureKind.InvalidRequest);
    }

    [Test]
    public async Task A_reset_keeps_a_copy_then_ends_every_conversation_and_rebuilds_the_database()
    {
        _engine.Reply = (session, _) =>
        {
            var slot = ((FreeSlots)session.FindAppointments(new("gp", "", "", "any"))).Slots[0].SlotId;
            session.NextTurn();
            session.BookAppointment(new(slot, "booked before the reset"));
            return new TurnResult("Booked.", [], TokenUsage.None);
        };
        var chat = await _chats.StartAsync("P001");
        await _chats.SendAsync(chat.ChatId, "book me in");

        var kept = await _chats.ResetAsync();

        kept.Should().StartWith(_practice.Options.BackupPath).And.EndWith("medassist-20261109-080000.db");
        using (var copy = new MedAssist.Data.SqlitePracticeRepository(kept!))
        {
            copy.UpcomingFor("P001", "2026-11-09T08:00").Should().Contain(s => s.Reason == "booked before the reset");
        }
        _chats.State("P001").Upcoming.Should().NotContain(a => a.Reason == "booked before the reset");
        _engine.Ended.Should().Be(1);
        _chats.State("P001").Upcoming.Should().ContainSingle();
        var send = () => _chats.SendAsync(chat.ChatId, "hello");
        await send.Should().ThrowAsync<ServiceException>();
    }

    [Test]
    public async Task A_patient_who_does_not_exist_cannot_start_a_conversation()
    {
        var start = () => _chats.StartAsync("P999");
        await start.Should().ThrowAsync<PatientNotFoundException>();
        _engine.Started.Should().BeEmpty();
    }

    [Test]
    public async Task Info_lists_the_patients_with_their_age_and_language()
    {
        var info = await _chats.InfoAsync();

        info.Engine.Should().Be("fake");
        info.Status.Ready.Should().BeTrue();
        info.Patients.Should().Contain(new PatientSummary("P007", "Andrei Ionescu", 68, "Romanian"));
        info.Patients.Should().HaveCount(PracticeData.Patients.Count);
    }
}
