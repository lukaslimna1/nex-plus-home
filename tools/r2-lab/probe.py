"""
NEX+ · Escopo 0.7B
R2 Local ONNX Runtime GenAI Feasibility Probe

Executa smoke test estruturado de carregamento e inferência com ONNX Runtime GenAI.
Gera evidência estruturada em formato JSON para auditoria do laboratório de viabilidade.
"""

import json
import os
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def get_gpu_info():
    try:
        res = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if res.returncode == 0:
            lines = res.stdout.strip().split("\n")
            if lines and lines[0]:
                parts = lines[0].split(",")
                gpu_name = parts[0].strip()
                vram_mb = int(parts[1].strip())
                return gpu_name, vram_mb * 1024 * 1024
    except Exception:
        pass
    return None, None


def sanitize_error(err_str: str) -> str:
    if not err_str:
        return ""
    # Reduz ruído de stack trace mantendo o motivo técnico central
    lines = [line.strip() for line in err_str.strip().split("\n") if line.strip()]
    return lines[-1] if lines else err_str


def get_directory_size(path: Path) -> int:
    total = 0
    if path.is_dir():
        for f in path.rglob("*"):
            if f.is_file():
                total += f.stat().st_size
    elif path.is_file():
        total = path.stat().st_size
    return total


def run_probe(model_dir: str, prompt_text: str = "Responda apenas com: NEX R2 OK") -> dict:
    observed_at = datetime.now(timezone.utc).isoformat()
    gpu_name, gpu_vram_bytes = get_gpu_info()
    model_path_obj = Path(model_dir)

    evidence = {
        "runtime": "onnxruntime_genai",
        "runtimeVersion": "unknown",
        "executionProvider": "directml",
        "pythonVersion": platform.python_version(),
        "os": f"{platform.system()} {platform.release()} ({platform.machine()})",
        "gpuName": gpu_name,
        "gpuVramBytes": gpu_vram_bytes,
        "modelFixture": "microsoft/Phi-3-mini-4k-instruct-onnx-directml-int4",
        "modelPath": str(model_path_obj.resolve()),
        "modelSizeBytes": get_directory_size(model_path_obj),
        "loadSucceeded": False,
        "generationSucceeded": False,
        "generatedText": None,
        "tokensGenerated": 0,
        "loadDurationMs": 0,
        "generationDurationMs": 0,
        "errorCode": None,
        "errorMessageSanitized": None,
        "observedAt": observed_at,
    }

    if not model_path_obj.exists():
        evidence["errorCode"] = "MODEL_PATH_NOT_FOUND"
        evidence["errorMessageSanitized"] = f"Model path does not exist: {model_dir}"
        return evidence

    try:
        import onnxruntime_genai as og

        evidence["runtimeVersion"] = getattr(og, "__version__", "unknown")
    except Exception as e:
        evidence["errorCode"] = "IMPORT_FAILED"
        evidence["errorMessageSanitized"] = sanitize_error(str(e))
        return evidence

    # 1. Carregamento do Modelo
    t_load_start = time.perf_counter()
    try:
        model = og.Model(str(model_path_obj))
        tokenizer = og.Tokenizer(model)
        t_load_end = time.perf_counter()
        evidence["loadSucceeded"] = True
        evidence["loadDurationMs"] = round((t_load_end - t_load_start) * 1000, 2)
    except Exception as e:
        t_load_end = time.perf_counter()
        evidence["loadDurationMs"] = round((t_load_end - t_load_start) * 1000, 2)
        evidence["errorCode"] = "MODEL_LOAD_FAILED"
        evidence["errorMessageSanitized"] = sanitize_error(str(e))
        return evidence

    # 2. Execução da Inferência
    t_gen_start = time.perf_counter()
    try:
        params = og.GeneratorParams(model)
        params.set_search_options(max_length=60)
        generator = og.Generator(model, params)

        formatted_prompt = f"<|user|>\n{prompt_text}<|end|>\n<|assistant|>\n"
        input_tokens = tokenizer.encode(formatted_prompt)
        generator.append_tokens(input_tokens)

        out_tokens = []
        while not generator.is_done():
            generator.generate_next_token()
            toks = generator.get_next_tokens()
            if toks:
                out_tokens.append(toks[0])

        t_gen_end = time.perf_counter()
        decoded_text = tokenizer.decode(out_tokens).strip()

        evidence["generationSucceeded"] = True
        evidence["generatedText"] = decoded_text
        evidence["tokensGenerated"] = len(out_tokens)
        evidence["generationDurationMs"] = round((t_gen_end - t_gen_start) * 1000, 2)
    except Exception as e:
        t_gen_end = time.perf_counter()
        evidence["generationDurationMs"] = round((t_gen_end - t_gen_start) * 1000, 2)
        evidence["errorCode"] = "GENERATION_FAILED"
        evidence["errorMessageSanitized"] = sanitize_error(str(e))
        return evidence

    return evidence


if __name__ == "__main__":
    default_model = "tools/r2-lab/models/Phi-3-mini-4k-instruct-onnx-directml-int4/directml/directml-int4-awq-block-128"
    target_path = sys.argv[1] if len(sys.argv) > 1 else default_model

    result = run_probe(target_path)
    print(json.dumps(result, indent=2, ensure_ascii=False))
