using MedAssist.Domain;
using MedAssist.Testing;

namespace MedAssist.Domain.Tests;

/// <summary>
/// MedAssist's rules, which live in the tools rather than the prompt, on a throwaway database at a fixed time: no
/// Azure, no model, no cost. The same rules backend/tests/test_medassist.py checks for the Python version.
/// </summary>
public class PatientSessionTests
{
    private TempPractice _practice = null!;

    [SetUp]
    public void FreshPractice() => _practice = new TempPractice();

    [TearDown]
    public void RemovePractice() => _practice.Dispose();

    [Test]
    public void A_slot_is_booked_only_after_the_patient_has_seen_it()
    {
        using var sam = _practice.Session("P002");
        var slot = Offer(sam);

        sam.BookAppointment(new(slot, "blood pressure review"))
           .Should().BeOfType<ToolError>().Which.Error.Should().Contain("has not seen these slots yet");

        sam.NextTurn();  // the patient has seen the slots and chosen one
        var booked = sam.BookAppointment(new(slot, "blood pressure review")).Should().BeOfType<AppointmentBooked>().Subject;
        booked.AppointmentId.Should().Be(slot);
        booked.ConfirmationSentTo.Should().Be("mobile ending 456");
        sam.Practice.CountTexts().Should().Be(1);
        sam.Practice.CountBookings(slot[..4]).Should().Be(1);
    }

    [Test]
    public void A_slot_that_was_never_offered_is_refused()
    {
        using var sam = _practice.Session("P002");
        sam.NextTurn();
        sam.BookAppointment(new("OKA-20261113-0900", "anything"))
           .Should().BeOfType<ToolError>().Which.Error.Should().Contain("only a slot that find_appointments offered");
    }

    [Test]
    public void A_slot_that_has_passed_is_refused_even_if_it_was_offered()
    {
        using var sam = _practice.Session("P002");
        var slot = Offer(sam);
        _practice.Time.UtcNow = _practice.Time.UtcNow.AddDays(40);  // every slot is now in the past
        sam.NextTurn();

        sam.BookAppointment(new(slot, "review"))
           .Should().BeOfType<ToolError>().Which.Error.Should().Be("That slot is no longer available. Find another.");
    }

    [Test]
    public void Two_patients_cannot_book_the_same_slot()
    {
        using var sam = _practice.Session("P002");
        using var margaret = _practice.Session("P003");
        var slot = Offer(sam);
        Offer(margaret).Should().Be(slot, "both were shown the same free slot");
        sam.NextTurn();
        margaret.NextTurn();

        sam.BookAppointment(new(slot, "review")).Should().BeOfType<AppointmentBooked>();
        margaret.BookAppointment(new(slot, "review"))
                .Should().BeOfType<ToolError>().Which.Error.Should().Contain("Someone else has just booked");
    }

    [Test]
    public void Cancelling_asks_first_and_cancels_only_on_a_later_turn()
    {
        using var valeria = _practice.Session("P001");
        valeria.NextTurn();
        var review = valeria.Upcoming().Should().ContainSingle().Subject.AppointmentId;  // the existing asthma review

        valeria.CancelAppointment(new(review)).Should().BeOfType<ConfirmCancel>();
        valeria.CancelAppointment(new(review)).Should().BeOfType<ConfirmCancel>("the same turn is not a yes");
        valeria.Upcoming().Should().HaveCount(1);

        valeria.NextTurn();
        valeria.CancelAppointment(new(review)).Should().BeOfType<AppointmentCancelled>();
        valeria.Upcoming().Should().BeEmpty();
        valeria.Practice.CountTexts().Should().Be(1);
    }

    [Test]
    public void Another_patients_appointment_cannot_be_cancelled()
    {
        string review;
        using (var valeria = _practice.Session("P001"))
        {
            review = valeria.Upcoming()[0].AppointmentId;
        }
        using var sam = _practice.Session("P002");
        sam.NextTurn();
        sam.CancelAppointment(new(review))
           .Should().BeOfType<ToolError>().Which.Error.Should().Be("That is not one of the patient's upcoming appointments.");
    }

    [Test]
    public void The_record_is_only_the_signed_in_patients_with_the_number_masked()
    {
        using var sam = _practice.Session("P002");
        var record = sam.GetMyRecord();
        record.Name.Should().Be("Sam Taylor");
        record.Mobile.Should().Be("ending 456");
        record.RegisteredGp.Should().Be("Dr Tom Okafor");
    }

    [Test]
    public void A_text_that_fails_is_audited_and_the_booking_stands()
    {
        using var practice = new TempPractice(new FailingNotifier());
        using var sam = practice.Session("P002");
        var slot = Offer(sam);
        sam.NextTurn();

        sam.BookAppointment(new(slot, "review")).Should().BeOfType<AppointmentBooked>().Which.Reminder.Should().BeNull();
        practice.Practice.Records("P002").Audit.Select(a => a.Action).Should().Contain("text sent: failed");
        practice.Practice.Records("P002").Upcoming.Select(a => a.AppointmentId).Should().Contain(slot);
    }

    [Test]
    public void The_portal_note_gives_the_day_and_who_is_signed_in()
    {
        using var sam = _practice.Session("P002");
        sam.PortalNote().Should().Be("Today is Monday 09 November 2026 (2026-11-09). The signed-in patient is Sam Taylor; " +
                                     "the portal has verified who they are.");
    }

    [Test]
    public void A_patient_who_does_not_exist_cannot_sign_in()
    {
        var open = () => _practice.Session("P999");
        open.Should().Throw<PatientNotFoundException>().Which.PatientId.Should().Be("P999");
    }

    private static string Offer(PatientSession session)
    {
        session.NextTurn();
        return session.FindAppointments(new("gp", "", "", "any")).Should().BeOfType<FreeSlots>().Subject.Slots[0].SlotId;
    }

    private sealed class FailingNotifier : INotifier
    {
        public string? Send(string patient, string body, string language) => throw new IOException("network down");

        public string? Schedule(string appointmentId, string patient, string body, string startsAt, string language) =>
            throw new IOException("network down");

        public string? Cancel(string appointmentId) => null;
    }
}
