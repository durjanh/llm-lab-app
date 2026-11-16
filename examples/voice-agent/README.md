# Local text to speech for the voice agent

`server.py` runs Kokoro-82M (Apache 2.0) through ONNX Runtime on this machine. No cloud, no PyTorch. The lab's
`/voice-agent` page starts it when you pick "Local (Kokoro)" as the voice engine.

## Set up

```sh
cd examples/voice-agent && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
mkdir -p ../../generated/voice-agent/kokoro && cd ../../generated/voice-agent/kokoro
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

About 330 MB of models. The server has no SSML: the page's expressiveness changes speaking speed only.
