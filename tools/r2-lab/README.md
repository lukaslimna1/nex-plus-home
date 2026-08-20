# NEX+ · R2 Local Feasibility Lab
**Escopo 0.7B — Laboratório Empírico de Viabilidade ONNX Runtime GenAI no Windows**

---

## 1. Objetivo

Provar empiricamente, no ambiente físico real do NEX+ (Windows 11, NVIDIA GeForce RTX 3060 12GB), a viabilidade técnica de um runtime local **R2** independente do ecossistema Ollama/llama.cpp usando **ONNX Runtime GenAI**.

---

## 2. O que este Laboratório Prova

1. **Independência de Processo**: ONNX Runtime GenAI carrega e executa inferência diretamente em processo Python nativo, sem dependência de daemon Ollama, sem chamadas HTTP na porta 11434 e sem subprocessos do llama.cpp.
2. **Aceleração por Hardware no Windows (DirectML)**: A inferência foi executada com aceleração por GPU via Direct3D 12 (DirectML) na RTX 3060, gerando a resposta esperada (`NEX R2 OK`).
3. **Isolamento Total**: O ambiente foi construído em virtualenv isolado (`tools/r2-lab/.venv`), sem poluir dependências globais ou do Node.js/NEX+.

---

## 3. O que este Laboratório NÃO Prova

1. **NÃO Escolhe Modelo R2**: O modelo `Phi-3-mini-4k-instruct-onnx` foi utilizado exclusivamente como fixture técnica reproduzível disponibilizada pela Microsoft. **Phi-3 NÃO é candidato promovido do MAX nem vira incumbente.**
2. **NÃO Substitui os Incumbentes R1**: `local_resident` (`ministral-3:3b`) e `local_heavy` (`qwen3.5:9b`) permanecem 100% inalterados no R1/Ollama.
3. **NÃO Cria Rota R2 de Produção**: Nenhum binding de AI Role, rota de L0 ou automação de fallback foi criada neste bloco.
4. **NÃO Executa Benchmark Competitivo**: Nenhuma comparação de tokens/sec, TTFT, inteligência ou qualidade foi realizada.

---

## 4. Diagnóstico de Execution Providers

### 4.1. Tentativa 1: CUDA (`onnxruntime-genai-cuda`)
- **Status**: `missing_toolkit / dll_load_failure`
- **Diagnóstico**: O pacote binário `onnxruntime-genai-cuda` 0.15.2 exige DLLs do CUDA Toolkit (`cublasLt64_13.dll` / `cudart64_12.dll`). Como o host possui apenas o driver de vídeo NVIDIA (610.88) sem o SDK completo do CUDA Toolkit instalado no PATH, o carregamento dinâmico da DLL falha. Em respeito às regras de segurança, nenhum SDK global foi instalado.

### 4.2. Tentativa 2: DirectML (`onnxruntime-genai-directml`)
- **Status**: `VIABLE_DIRECTML` (Sucesso pleno)
- **Diagnóstico**: O DirectML opera nativamente sobre a API DirectX 12 do Windows 11, utilizando a GPU NVIDIA GeForce RTX 3060 sem exigir a instalação de toolkits proprietários adicionais.
- **Duração de Load**: ~3.2 segundos
- **Duração de Geração**: ~2.0 segundos (6 tokens: `"NEX R2 OK"`)

---

## 5. Como Reproduzir o Teste

```powershell
# 1. Ativar o virtualenv isolado do laboratório
.\tools\r2-lab\.venv\Scripts\Activate.ps1

# 2. Executar o probe estruturado
python tools/r2-lab/probe.py
```

---

## 6. Localização dos Modelos (Fora do Git)

Os pesos quantizados em INT4 (~2.13 GB) residem localmente em:
```text
tools/r2-lab/models/Phi-3-mini-4k-instruct-onnx-directml-int4/
```
Este diretório está explicitamente ignorado no `.gitignore` e **nunca** é versionado.

---

## 7. Classificação Final

- **Resultado Factual**: **`VIABLE_DIRECTML`**
