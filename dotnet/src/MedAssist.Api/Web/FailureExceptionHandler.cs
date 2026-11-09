using MedAssist.Api.Contracts;
using MedAssist.Application;
using Microsoft.AspNetCore.Diagnostics;

namespace MedAssist.Api.Web;

/// <summary>
/// Every failure the layers below report, as {"error": {"type", "message"}} with a status for its kind, the shape
/// the page's ApiClient reads. The classifiers decide what a failure means; this only says it over HTTP.
/// </summary>
public sealed class FailureExceptionHandler(FailureReporter failures, ILogger<FailureExceptionHandler> log) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken cancellationToken)
    {
        var failure = failures.Classify(exception);
        var status = StatusFor(failure.Kind);
        if (status >= 500)
        {
            log.LogWarning(exception, "MedAssist request failed: {Message}", failure.Message);
        }
        context.Response.StatusCode = status;
        await context.Response.WriteAsJsonAsync(new ErrorResponse(new ErrorBody(failure.Type, failure.Message)),
                                                ApiJson.Options, cancellationToken);
        return true;
    }

    public static int StatusFor(FailureKind kind) => kind switch
    {
        FailureKind.InvalidRequest => StatusCodes.Status400BadRequest,
        FailureKind.NotFound => StatusCodes.Status404NotFound,
        FailureKind.Busy => StatusCodes.Status409Conflict,
        FailureKind.BudgetExceeded => StatusCodes.Status429TooManyRequests,
        FailureKind.NotConfigured => StatusCodes.Status503ServiceUnavailable,
        _ => StatusCodes.Status502BadGateway,
    };
}
