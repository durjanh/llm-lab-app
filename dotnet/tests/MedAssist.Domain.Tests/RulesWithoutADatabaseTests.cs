using MedAssist.Domain;
using MedAssist.Testing;

namespace MedAssist.Domain.Tests;

/// <summary>The rules against a stub repository: the session depends only on the port, so no database is needed.</summary>
public class RulesWithoutADatabaseTests
{
    private readonly FixedTimeProvider _time = new();

    [Test]
    public void When_the_slot_is_taken_between_showing_and_booking_nothing_is_texted()
    {
        var practice = new StubRepository { ClaimSucceeds = false };
        practice.Free.Add(new FreeSlot("OKA-20261110-0900", "2026-11-10T09:00", "Dr Tom Okafor"));
        practice.Slots["OKA-20261110-0900"] = new SlotDetails("OKA-20261110-0900", "2026-11-10T09:00", "face_to_face", "Dr Tom Okafor");
        using var sam = new PatientSession(practice, "P002", NullNotifier.Instance, _time);
        sam.NextTurn();
        sam.FindAppointments(new("gp", "", "", "any"));
        sam.NextTurn();

        sam.BookAppointment(new("OKA-20261110-0900", "review"))
           .Should().BeOfType<ToolError>().Which.Error.Should().Contain("Someone else has just booked");
        practice.TextsSent.Should().BeEmpty();
        practice.Audit.Should().NotContain("appointment booked");
    }

    [Test]
    public void An_unknown_appointment_type_is_an_error_the_model_can_read()
    {
        using var sam = new PatientSession(new StubRepository(), "P002", NullNotifier.Instance, _time);
        sam.FindAppointments(new("dentist", "", "", "any"))
           .Should().BeOfType<ToolError>().Which.Error.Should().Be("appointment_type must be one of gp, phone, nurse, pharmacist");
    }

    [Test]
    public void A_patient_prefers_the_language_in_their_record_unless_told_otherwise()
    {
        var andrei = new StubRepository { Patient = PracticeData.Patients.Single(p => p.Id == "P007") };
        new PatientSession(andrei, "P007", NullNotifier.Instance, _time).Language.Should().Be("ro");
        new PatientSession(andrei, "P007", NullNotifier.Instance, _time, "pl").Language.Should().Be("pl");
    }
}
