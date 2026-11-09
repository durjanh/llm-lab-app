using MedAssist.Api.Contracts;
using MedAssist.Application;
using MedAssist.Domain;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace MedAssist.Api.Controllers;

/// <summary>
/// MedAssist's patient portal API, at the routes the lab's page calls (backend/app/api/medassist.py). Thin: each
/// action calls the service layer and maps its result; the rules and the agent are below it.
/// </summary>
[ApiController]
[Route("api/medassist")]
public sealed class MedAssistController(ChatService chats, IOptions<MedAssistOptions> options) : ControllerBase
{
    [HttpGet("info")]
    public async Task<InfoResponse> Info(CancellationToken cancellationToken) => (await chats.InfoAsync(cancellationToken)).ToResponse();

    /// <summary>A new conversation for a signed-in patient. The portal, not the model, says who that is.</summary>
    [HttpPost("chats")]
    public async Task<ChatStartedResponse> Start(StartChatRequest request, CancellationToken cancellationToken) =>
        (await chats.StartAsync(request.PatientId, cancellationToken)).ToResponse();

    [HttpPost("chats/{chatId}/messages")]
    public async Task<ChatReplyResponse> Send(string chatId, SendMessageRequest request, CancellationToken cancellationToken) =>
        (await chats.SendAsync(chatId, request.Message, cancellationToken)).ToResponse();

    [HttpDelete("chats/{chatId}")]
    public async Task<ChatEndedResponse> End(string chatId) => new(await chats.EndAsync(chatId));

    /// <summary>What the practice's systems hold for the patient: record, appointments, texts sent, audit log.</summary>
    [HttpGet("patients/{patientId}")]
    public PracticeStateDto State(string patientId) => chats.State(patientId).ToResponse();

    [HttpPost("reset")]
    public async Task<ResetResponse> Reset() => new(true, PracticeData.WeeksAhead, await chats.ResetAsync());

    /// <summary>The practice's phone line runs in the Python backend only; the page asks, so it is told.</summary>
    [HttpGet("phone")]
    public PhoneLineResponse Phone() =>
        new(false, ["the phone line runs in the Python backend (python -m backend)"], options.Value.PhonePatient);
}
