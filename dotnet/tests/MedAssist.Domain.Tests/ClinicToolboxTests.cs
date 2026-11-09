using MedAssist.Domain;
using MedAssist.Testing;

namespace MedAssist.Domain.Tests;

/// <summary>How a tool call from the model reaches the rules, and what the model reads back.</summary>
public class ClinicToolboxTests
{
    private readonly ClinicToolbox _toolbox = ClinicToolbox.Standard();
    private readonly FixedTimeProvider _time = new();

    [Test]
    public void The_four_tools_have_the_names_and_schemas_the_python_version_gives_the_model()
    {
        _toolbox.Specs.Select(s => s.Name).Should().Equal("get_my_record", "find_appointments", "book_appointment", "cancel_appointment");
        _toolbox.Specs.Should().AllSatisfy(s => s.ParametersJson.Should().Contain("\"additionalProperties\": false"));
    }

    [Test]
    public void A_call_reaches_its_tool_with_the_arguments_read_into_a_typed_request()
    {
        using var sam = Session();
        sam.NextTurn();
        _toolbox.Call(sam, "find_appointments", """{"appointment_type": "dentist", "clinician": "", "earliest_date": "", "time_of_day": "any"}""")
                .Should().BeOfType<ToolError>().Which.Error.Should().StartWith("appointment_type must be one of");
    }

    [Test]
    public void A_tool_that_does_not_exist_bad_json_and_missing_arguments_are_errors_the_model_can_read()
    {
        using var sam = Session();
        _toolbox.Call(sam, "delete_everything", "{}").Should().BeOfType<ToolError>().Which.Error.Should().Contain("no tool called");
        _toolbox.Call(sam, "book_appointment", "{not json").Should().BeOfType<ToolError>().Which.Error.Should().Contain("not valid JSON");
        _toolbox.Call(sam, "book_appointment", """{"slot_id": "x"}""")
                .Should().BeOfType<ToolError>().Which.Error.Should().StartWith("Bad arguments for book_appointment");
    }

    [Test]
    public void The_model_gets_the_same_json_as_the_python_version()
    {
        new AppointmentBooked("OKA-20261112-0940", "Dr Tom Okafor", "Thursday 12 November at 09:40", "face to face", "mobile ending 456")
            .ToJson().Should().Be("""{"booked":true,"appointment_id":"OKA-20261112-0940","with":"Dr Tom Okafor","when":"Thursday 12 November at 09:40","kind":"face to face","confirmation_sent_to":"mobile ending 456"}""");
        new ConfirmCancel("Ask the patient to confirm.").ToJson().Should().Be("""{"cancelled":false,"confirm_first":"Ask the patient to confirm."}""");
        new FreeSlots([], "Nothing free.").ToJson().Should().Be("""{"slots":[],"note":"Nothing free."}""");
        new ToolError("No.").ToJson().Should().Be("""{"error":"No."}""");
    }

    [Test]
    public void Slot_times_read_as_the_patient_hears_them() =>
        PracticeCalendar.Spoken("2026-11-12T09:40").Should().Be("Thursday 12 November at 09:40");

    private PatientSession Session() => new(new StubRepository(), "P002", NullNotifier.Instance, _time);
}
