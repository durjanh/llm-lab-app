using MedAssist.Api.Contracts;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace MedAssist.Api.Web;

/// <summary>
/// Only the lab's own pages may spend your credit, as backend/app/api/deps.py's require_lab_page does it. The
/// X-LLM-Lab header forces a CORS preflight, which this API never approves (it has no CORS policy), so other
/// websites cannot make your browser call it. An Origin, when sent, must be this machine. The Host header is
/// checked by ASP.NET's host filtering (AllowedHosts in appsettings.json), which blocks DNS-rebinding tricks.
/// </summary>
public sealed class LabPageFilter : IResourceFilter
{
    public const string Header = "X-LLM-Lab";

    private static readonly string[] LocalHosts = ["localhost", "127.0.0.1"];

    public void OnResourceExecuting(ResourceExecutingContext context)
    {
        var request = context.HttpContext.Request;
        var origin = request.Headers.Origin.ToString();
        var fromThisMachine = origin.Length == 0
                              || (Uri.TryCreate(origin, UriKind.Absolute, out var uri) && LocalHosts.Contains(uri.Host));
        if (request.Headers[Header] != "1" || !fromThisMachine)
        {
            context.Result = new ObjectResult(new ErrorResponse(new ErrorBody("forbidden",
                "API calls are only accepted from the lab pages on this server."))) { StatusCode = StatusCodes.Status403Forbidden };
        }
    }

    public void OnResourceExecuted(ResourceExecutedContext context)
    {
    }
}
