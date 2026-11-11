#!/usr/bin/env python3
import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser(description="Transcribe one audio file with faster-whisper.")
    parser.add_argument("audio_path")
    parser.add_argument("--model", default="base")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(
            "Could not import faster_whisper. Install it with: "
            "python3 -m pip install -r requirements.txt",
            file=sys.stderr,
        )
        print(str(exc), file=sys.stderr)
        return 2

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    text, info, segment_count, used_vad = transcribe(model, args.audio_path, args.language or None, True)
    if not text:
        text, info, segment_count, used_vad = transcribe(model, args.audio_path, args.language or None, False)

    payload = {
        "text": text,
        "language": getattr(info, "language", None),
        "language_probability": getattr(info, "language_probability", None),
        "duration": getattr(info, "duration", None),
        "segment_count": segment_count,
        "vad_filter": used_vad,
        "model": args.model,
        "device": args.device,
        "compute_type": args.compute_type,
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def transcribe(model, audio_path, language, vad_filter):
    segments, info = model.transcribe(
        audio_path,
        language=language,
        vad_filter=vad_filter,
    )
    texts = []
    for segment in segments:
        text = segment.text.strip()
        if text:
            texts.append(text)
    return " ".join(texts).strip(), info, len(texts), vad_filter


if __name__ == "__main__":
    raise SystemExit(main())
