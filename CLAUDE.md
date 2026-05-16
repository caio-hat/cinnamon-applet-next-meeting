# Handoff: Next Meeting — Cinnamon Applet

## Repositório ativo

**`caio-hat/cinnamon-applet-next-meeting`** (branch: `main`)

> Repo anterior (`caio-hat/applet-cinnamon-outlookcalendar`, branch
> `claude/cinnamon-outlook-applet-TTEre`) foi o histórico de desenvolvimento —
> está arquivado, não é mais o repo de trabalho.

---

## Restrição crítica

Ao eventualmente trabalhar com o repo oficial da comunidade
(`linuxmint/cinnamon-spices-applets`), **NUNCA** ler arquivos de outros
applets de outros usuários — evitar poluição de contexto e gasto desnecessário
de tokens.

---

## O que é o projeto

Applet para o painel do **Cinnamon** (Linux Mint) que mostra a próxima reunião
do dia diretamente na barra. Funciona com **qualquer URL ICS/iCal padrão**:
Google Calendar, Outlook/M365, Apple Calendar, Nextcloud, Fastmail, Proton
Calendar — qualquer feed RFC 5545.

**UUID:** `next-meeting@caio-hat`  
**Versão:** `2.3.0`  
**Linguagens:** GJS (JavaScript/SpiderMonkey 102–140) + Python 3  
**i18n:** gettext — inglês como fonte, pt_BR incluído  

---

## Estrutura do repositório

```
cinnamon-applet-next-meeting/
├── README.md
├── LICENSE                         (MIT)
├── .gitignore
├── setup.sh                        (instala localmente: deps Python, tradução, copia arquivos)
└── next-meeting@caio-hat/          (estrutura cinnamon-spices-applets)
    ├── info.json                   ({"author": "caio-hat"})
    └── files/
        └── next-meeting@caio-hat/
            ├── metadata.json
            ├── applet.js           (666 linhas — lógica principal GJS)
            ├── fetch_meetings.py   (296 linhas — busca e parse ICS via Python)
            ├── settings-schema.json
            ├── stylesheet.css
            └── po/
                ├── next-meeting@caio-hat.pot  (template)
                └── pt_BR.po                   (tradução pt-BR completa)
```

### Convenção cinnamon-spices-applets

O repo official (`linuxmint/cinnamon-spices-applets`) exige:
- `<UUID>/info.json` com `{"author": "..."}` na raiz
- `<UUID>/files/<UUID>/` com os arquivos instaláveis
- `<UUID>/files/<UUID>/metadata.json` com uuid, name, version, icon, etc.

---

## Arquitetura

### applet.js (GJS)

```
class NextMeetingApplet extends Applet.TextIconApplet
  constructor()
    → settings.bind() para todas as preferências
    → _buildMenu()      cria o popup menu
    → _startRefreshTimer()  recarrega reuniões (padrão: 5 min)
    → _startNotifyTimer()   atualiza display + notificações (30s)
    → _fetchMeetings()  busca inicial

  _fetchMeetings()
    → Gio.Subprocess.new(["python3", "fetch_meetings.py"])
    → stdin: JSON array de calendários
    → stdout: JSON {"meetings": [...]} ou {"error": "..."}

  _renderMenu()
    → Classifica reuniões: _inProgress, future[]
    → todayFuture = future filtrado por toDateString() === hoje
    → _panelMeeting = _inProgress || nextAccepted || nextTentative (só hoje)
    → _hasFutureMeetings = future.length > 0  (para saber se há reuniões outro dia)
    → Detecta conflitos
    → Preenche sub-menus (24h, 3d, 7d)

  _updateDisplay()
    → _panelMeeting = null + _hasFutureMeetings → label "✓", tooltip "Nenhuma reunião restante hoje"
    → _panelMeeting = null + !_hasFutureMeetings → label "Sem reuniões"
    → hiddenMode: mostra só contagem regressiva
    → marqueeEnabled + label longo → _startMarquee() [label estática sem countdown]
    → timerPosition "start"/"end" → posição do horário no label

  Marquee (scrolling):
    _startMarquee()  → Mainloop.timeout_add(speedMs) rodando _tickMarquee()
    _stopMarquee()   → remove timer, reseta offset e texto
    _tickMarquee()   → fatia texto+padding, avança offset
    Usa label ESTÁTICA (horário de término, não countdown) para não resetar o
    scroll a cada 30s quando o countdown muda.

  _openSettings()
    → ["xlet-settings", "applet", UUID, "--id", String(id)]
    → IMPORTANTE: instance_id é FLAG --id, NÃO argumento posicional
    → Fallback: cinnamon-settings applets UUID

  Timers:
    GLib.SOURCE_CONTINUE / GLib.SOURCE_REMOVE (padrão cinnamon-spices)
    _refreshTimer  → Mainloop.timeout_add_seconds()
    _notifyTimer   → Mainloop.timeout_add_seconds(30)
    _marqueeTimer  → Mainloop.timeout_add(speedMs)
    Todos removidos em on_applet_removed_from_panel()
```

### fetch_meetings.py (Python 3)

- Recebe lista de calendários via **stdin** (JSON)
- Para cada calendário habilitado: baixa ICS via `urllib.request`
- Parse via `icalendar` + `recurring_ical_events` (se disponível) ou fallback regex builtin
- Extrai status: `X-MICROSOFT-CDO-BUSYSTATUS` (TENTATIVE/BUSY/OOF/FREE) e `STATUS`
- Detecta join URLs (Teams, Google Meet, Zoom, Whereby) via regex
- Filtra janela: agora até +7 dias
- Saída: `{"meetings": [{uid, subject, start, end, location, join_url, status, calendar_name, calendar_color}]}`
- Warnings separados de errors (permite reuniões parciais com avisos)

---

## Configurações (settings-schema.json)

| Chave            | Tipo        | Padrão  | Descrição                              |
|------------------|-------------|---------|----------------------------------------|
| calendars        | list        | []      | URLs ICS com name/url/color/enabled    |
| show-in-panel    | switch      | true    | Exibe texto no painel                  |
| label-max-chars  | spinbutton  | 40      | Máx caracteres no label               |
| timer-position   | combobox    | "start" | Horário antes/depois do nome          |
| marquee-enabled  | switch      | false   | Texto rolante para nomes longos       |
| marquee-speed    | spinbutton  | 4       | Velocidade scroll (×100ms, 1–20)      |
| show-tentative   | switch      | true    | Mostra reuniões tentativas no popup   |
| hidden-mode      | switch      | false   | Modo oculto (só countdown)            |
| notify-enabled   | switch      | true    | Notificar antes da reunião            |
| notify-before    | spinbutton  | 30      | Minutos de antecedência               |
| notify-conflicts | switch      | true    | Notificar conflitos de horário        |
| refresh-interval | spinbutton  | 5       | Intervalo de atualização (minutos)    |

**combobox timer-position:** `{"Before meeting name": "start", "After meeting name": "end"}`  
Em `applet.js`: `this.timerPosition !== "end"` → posição antes.

---

## Comportamentos chave implementados

### Day boundary (reunião do dia seguinte nunca aparece no painel)
```javascript
let todayStr    = new Date().toDateString();
let todayFuture = future.filter(m => new Date(m.start).toDateString() === todayStr);
this._panelMeeting      = this._inProgress || nextAccepted || nextTentative; // só hoje
this._hasFutureMeetings = future.length > 0;
```
Quando `_panelMeeting = null` mas `_hasFutureMeetings = true` → painel mostra `✓`.

### Timer position
- `timerPosition = "start"` (padrão): `14:30  Nome da Reunião` / `◎ (5 min atrás)  Nome`
- `timerPosition = "end"`: `Nome da Reunião  14:30` / `◎ Nome  (5 min atrás)`

### Marquee
- Só ativa quando `marqueeEnabled = true` E `staticLabel.length > labelMaxChars`
- Label estática = nome + horário de término (sem countdown → não reseta ao mudar)
- `_tickMarquee()`: `(padded + text).slice(offset, offset + max)`, offset % padded.length

### Detecção de conflitos
Dois eventos se conflitam se `startA < endB && startB < endA` e nenhum tem status "free".

### Migração de config legada
Lê `~/.config/outlook-calendar-applet/config.json` (formato antigo) na primeira execução.

---

## i18n / gettext

- Domínio: `next-meeting@caio-hat`
- Localização: `~/.local/share/locale/<lang>/LC_MESSAGES/next-meeting@caio-hat.mo`
- `setup.sh` compila `.po → .mo` via `msgfmt`
- `applet.js`: `Gettext.bindtextdomain(UUID, ...)` + funções `_()`, `_f()`, `_np()`
- `fetch_meetings.py`: `gettext.translation(UUID, LOCALE_DIR, fallback=True)`

---

## Como instalar e testar localmente

```bash
git clone https://github.com/caio-hat/cinnamon-applet-next-meeting.git
cd cinnamon-applet-next-meeting
bash setup.sh            # instala deps Python, compila .po, copia para ~/.local/share/cinnamon/applets/
cinnamon --replace &     # recarrega Cinnamon
# Adicionar applet: clique direito no painel → Adicionar applets → "Next Meeting" → +
# Configurar: clique direito no applet → Configurar → adicionar URL ICS
```

**Logs de depuração:**
```bash
tail -f ~/.xsession-errors | grep next-meeting   # X11
journalctl _COMM=cinnamon -f                      # systemd
# Alt+F2 → lg → cinnamon-looking-glass (GUI)
```

**Teste rápido do fetch_meetings.py:**
```bash
echo '[{"name":"Test","url":"https://calendar.google.com/calendar/ical/SEU_ICS","color":"#1e88e5","enabled":true}]' \
  | python3 ~/.local/share/cinnamon/applets/next-meeting@caio-hat/fetch_meetings.py | python3 -m json.tool
```

---

## Pendências / Próximos passos

### Obrigatórios para submeter ao cinnamon-spices
1. **`icon.png`** — 48×48 px, no diretório `next-meeting@caio-hat/` (raiz do UUID)
2. **`screenshot.png`** — screenshot do applet em funcionamento, mesmo diretório
   - Tamanho sugerido pela comunidade: ~800×500 px

### Qualidade / UX
3. **Testes end-to-end** — instalar via `setup.sh`, validar:
   - `✓` aparece após último meeting do dia
   - Marquee rola corretamente sem resetar posição a cada 30s
   - `timer-position` muda a posição do horário
   - Configurações abrem via `xlet-settings` (botão "Settings" no popup)
4. **Testar com Google Calendar** — obter URL ICS pública e validar parse de eventos recorrentes

### PR para cinnamon-spices (futuro)
5. Ao submeter PR para `linuxmint/cinnamon-spices-applets`:
   - Copiar `next-meeting@caio-hat/` (com `info.json` + `files/`) para o repo da comunidade
   - **NÃO ler outros applets do repo** ao fazer isso
   - Seguir o guia de submissão: https://github.com/linuxmint/cinnamon-spices-applets/blob/master/README.md

---

## Decisões técnicas importantes (histórico)

| Problema | Solução |
|----------|---------|
| `xlet-settings` rejeitava instance_id posicional | Usar flag `--id <id>` — argparse define como FLAG, não posicional |
| `colorchooser` em coluna de `list` crashava settings | Usar `"type": "string"` na coluna de cor |
| Logs não apareciam em `journalctl --user` | Cinnamon loga em `~/.xsession-errors` por padrão |
| Marquee resetava posição ao atualizar countdown | Label estática (horário de término, não countdown) para o texto rolante |
| Reunião do dia seguinte aparecia no painel | Filtrar `_panelMeeting` apenas para `toDateString() === hoje` |

---

## Contato / histórico

Sessão de desenvolvimento anterior: `caio-hat/applet-cinnamon-outlookcalendar`
branch `claude/cinnamon-outlook-applet-TTEre` — contém todo o histórico de commits
desde a versão inicial (outlook-only) até a v2.3.0 (next-meeting genérico).
