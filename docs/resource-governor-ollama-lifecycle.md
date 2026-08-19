# NEX+ · Resource Governor & Local Runtime Lifecycle
### Especificação Factual e Governança de Recursos Locais — Escopo 0.6

---

## 1. Responsabilidade e Fronteiras do Escopo 0.6

O **Resource Governor** responde estritamente à pergunta:
> *"Este workload local pode utilizar recursos físicos do sistema (RAM, VRAM, CPU, GPU) neste momento e sob este perfil?"*

### O que o Resource Governor NÃO faz:
- Não escolhe qual modelo é "melhor" ou "mais inteligente" (sem benchmarks, sem rankings MMLU/coding, sem TTFT ou tokens/sec — fronteira reservada ao Escopo 0.7).
- Não define nem substitui Policy (Egress/Zero-Cost), Authorization (L1/Humana) ou Confirmation.
- Não realiza auto-eviction de modelos sob pressão de VRAM.
- Não altera configurações do sistema operacional (Windows Power Plans, prioridade de processos, clocks de GPU).

---

## 2. Ollama Local como Runtime Executor (Não Autoridade)

O Ollama é tratado no NEX+ como um **runtime local executável** e **fonte de observabilidade**, jamais como autoridade de governança:
1. **Loopback Estrito**: Aceita conexões exclusivamente em `127.0.0.1`, `localhost` e `::1`. Endereços remotos ou externos são terminantemente proibidos.
2. **Catálogo Local Aprovado (`ApprovedLocalModelRef`)**: O lifecycle só pode atuar sobre modelos aprovados formalmente pela configuração/L0. Descoberta via `/api/tags` não confere aprovação automática.
3. **Comandos Explícitos**:
   - **Preload**: `POST /api/generate` com `keep_alive: -1`.
   - **Unload**: `POST /api/generate` com `keep_alive: 0`.
4. **Verificação Factual Pós-Comando**: Sucesso de transporte HTTP (200 OK) não comprova estado. O Governor exige verificação fática do estado em `/api/ps` antes de emitir `verified_loaded` ou `verified_unloaded`. Estados não comprovados resultam em `indeterminate`.
5. **Sem Operações Perigosas**: O cliente Ollama não expõe métodos públicos para `pull`, `push`, `create`, `delete` ou `copy`.

---

## 3. Telemetria e Resource Snapshot

O `ResourceSnapshot` agrega telemetria de forma pura sem misturar regras de decisão:
- **System Telemetry (`node:os`)**: RAM total, livre e usada. Utilização de CPU calculada via delta entre amostras de `os.cpus().times` por core. **Não** utiliza `os.loadavg()` no Windows.
- **NVIDIA GPU Telemetry (`nvidia-smi`)**: Consultas read-only sem shell interpolation. Preserva 0% real de utilização. Ausência de GPU ou binário resulta em status `unavailable` sem fabricar métricas falsas e sem derrubar o sistema.
- **Ollama Telemetry (`/api/ps`, `/api/tags`)**: Observação de modelos carregados, `size_vram` factual e context length.

---

## 4. Resource Profile Revision (`ResourceProfileRevision`)

Perfis imutáveis de governança que configuram:
- `minimumFreeSystemRamBytes`: Margem mínima obrigatória de RAM livre para o sistema operacional.
- `minimumFreeVramBytes`: Margem mínima obrigatória de VRAM livre na GPU.
- `maximumCpuUtilizationPercent` / `maximumGpuUtilizationPercent`: Tetos de pressão operacional.
- `maximumTelemetryAgeMs`: Tolerância máxima de idade da telemetria (snapshots mais antigos são considerados `stale`).
- `allowModelPreload` / `allowModelUnload`: Permissão para acionar ações de lifecycle.

---

## 5. Resource Leases e Semântica de Alocação

O `ResourceLeaseStore` gerencia leases de recursos com 4 estados bem definidos:
- **`reserved`**: Workload ou lifecycle em andamento. A reserva numérica ainda não foi refletida na telemetria física, logo **é descontada do headroom disponível**.
- **`active`**: Workload/modelo já em execução física. Como o consumo já é medido pela telemetria do sistema/GPU, a reserva **não é descontada novamente** (evita *double-counting*). O lease permanece ativo **protegendo o modelo contra unload**.
- **`released`**: Workload encerrado; proteção e reserva removidas.
- **`expired`**: Lease reconciliado por expiração temporal explícita (`reconcileExpiredLeases(at)`).

---

## 6. Motor de Decisão (`evaluateResourceRequest`)

Função pura, determinística e sem relógio interno:
- **`admit`**: Recursos físicos suficientes, telemetria fresca, perfil satisfeito e nenhuma ação de ciclo de vida pendente.
- **`action_required`**: Necessária ação explícita (`preload_model` ou `unload_model`) antes da admissão final. Exige novo ciclo completo de snapshot e avaliação após o comando.
- **`defer`**: Condição temporária (telemetria stale, RAM/VRAM insuficiente no momento, CPU/GPU em pico, estimativas ausentes, múltiplas GPUs sem target explícito).
- **`deny`**: Condição estrutural violada (modelo não aprovado no catálogo, ação proibida pelo perfil, GPU target inexistente, modelo protegido por lease ativo).

### Proibição de Auto-Eviction sob Pressão de VRAM
Quando a VRAM é insuficiente devido a outros modelos carregados, o Governor identifica os modelos livres como `evictionCandidates` e retorna `defer`. É terminantemente proibido escolher e descarregar um modelo automaticamente sem um plano determinístico de L0.

---

## 7. Integração com o Core 0.5 (`DispatchAdmission`)

Quando uma rota depende de governança local de recursos:
1. O Core 0.5 emite a `DispatchAdmission` (validação de Policy, Terms, RuntimeFacts e Authorization).
2. O Resource Governor emite a `ResourceAdmission` (admissão de RAM, VRAM e modelo local).
3. O wrapper `buildResourceGovernedAttemptCreatedEvent()` valida a coincidência estrita de linhagem causal (`decisionId`, `materialContextId`, `routeEvaluationId`, `routeRevisionId`) antes de instanciar o `AttemptCreatedEvent` canônico.
4. Rotas que não operam modelos locais utilizam diretamente o construtor do 0.5 sem acoplamento indevido.
