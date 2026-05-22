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

## Regra operacional: reinstalar após edição

Editar arquivos em `next-meeting@caio-hat/files/next-meeting@caio-hat/` **não**
afeta o applet rodando — o Cinnamon carrega de `~/.local/share/cinnamon/applets/<UUID>/`.

Antes de debugar "bug após mudança recente":

```bash
stat -c '%y %s' ~/.local/share/cinnamon/applets/next-meeting@caio-hat/applet.js
stat -c '%y %s' next-meeting@caio-hat/files/next-meeting@caio-hat/applet.js
```

Se mtimes/tamanhos diferentes → instalado está obsoleto. Rodar:

```bash
bash setup.sh           # copia arquivos do repo para o diretório do Cinnamon
cinnamon --replace &    # recarrega
```

Só investigar código se instalado bater com o repo e bug ainda reproduzir.
Esse passo já causou debug perdido (v2.5.3 marquee).

---

## O que é o projeto

Applet para o painel do **Cinnamon** (Linux Mint) que mostra a próxima reunião
do dia diretamente na barra. Funciona com **qualquer URL ICS/iCal padrão**:
Google Calendar, Outlook/M365, Apple Calendar, Nextcloud, Fastmail, Proton
Calendar — qualquer feed RFC 5545.

**UUID:** `next-meeting@caio-hat`  
**Versão atual:** `2.5.3`  
**Linguagens:** GJS (JavaScript/SpiderMonkey 102–140) + Python 3  
**i18n:** gettext — inglês como fonte, pt_BR incluído  
**Branding:** `logo.svg`/`logo.png` (raiz), `next-meeting@caio-hat/icon.svg`/`icon.png`  

---

## Estrutura do repositório

```
cinnamon-applet-next-meeting/
├── README.md
├── CHANGELOG.md                    (Keep a Changelog format, v2.0 → atual)
├── CLAUDE.md                       (este arquivo)
├── LICENSE                         (MIT)
├── .gitignore
├── setup.sh                        (instala localmente: deps Python, tradução, copia arquivos)
├── logo.svg / logo.png             (marca completa com wordmark, 440x96 viewBox)
└── next-meeting@caio-hat/          (estrutura cinnamon-spices-applets)
    ├── info.json                   ({"author": "caio-hat"})
    ├── icon.svg / icon.png         (48x48 — para listing cinnamon-spices)
    └── files/
        └── next-meeting@caio-hat/
            ├── metadata.json       (version, uuid, max-instances=-1, etc.)
            ├── applet.js           (~870 linhas — lógica principal GJS)
            ├── fetch_meetings.py   (~363 linhas — busca e parse ICS via Python)
            ├── settings-schema.json
            ├── stylesheet.css
            └── po/
                ├── next-meeting@caio-hat.pot  (template)
                └── pt_BR.po                   (tradução pt-BR completa)
```

### Convenção cinnamon-spices-applets

O repo oficial (`linuxmint/cinnamon-spices-applets`) exige:
- `<UUID>/info.json` com `{"author": "..."}` na raiz
- `<UUID>/files/<UUID>/` com os arquivos instaláveis
- `<UUID>/files/<UUID>/metadata.json` com uuid, name, version, icon, etc.
- `<UUID>/icon.png` 48×48 + `<UUID>/screenshot.png` para a listagem

---

## Branding

Conceito do logo: mostrador de relógio com ponteiro inclinado para a
posição ~1:30 apontando para um ponto laranja (`#ff7043`) — leitura
imediata como "tempo + próximo evento + iminência". Tile com gradiente
`#1e88e5 → #3949ab` (calendar-agnostic, sem referência a Google/Outlook/Apple).

**Re-rasterizar SVG → PNG:**

ImageMagick `convert` SEM `librsvg2-bin`/`rsvg-convert` instalado renderiza
SVG com renderer MSVG interno — perde gradientes (fica preto) e quebra
fonte do wordmark. Usar `cairosvg` em vez disso:

```bash
pip3 install --user --break-system-packages cairosvg
python3 -c "
import cairosvg
cairosvg.svg2png(url='next-meeting@caio-hat/icon.svg',
                 write_to='next-meeting@caio-hat/icon.png',
                 output_width=48, output_height=48)
cairosvg.svg2png(url='logo.svg', write_to='logo.png', output_width=960)
"
```

Alternativa com sudo: `sudo apt install librsvg2-bin` (adiciona `rsvg-convert`,
que ImageMagick usa automaticamente como delegate).

---

## Arquitetura

### applet.js (GJS, ~870 linhas)

```
class NextMeetingApplet extends Applet.TextIconApplet
  constructor()
    → settings.bind() para todas as preferências (incluindo hide-subject,
      show-tentative-in-panel)
    → _setupNotifications()   inicializa proxy D-Bus org.freedesktop.Notifications
    → _buildMenu()            cria popup com switches inline + Help submenu
    → _startRefreshTimer()    recarrega reuniões (padrão: 5 min)
    → _startNotifyTimer()     atualiza display + verifica notificações (30s)
    → _fetchMeetings()        busca inicial

  _fetchMeetings()
    → Gio.Subprocess.new(["python3", "fetch_meetings.py"])
    → stdin: JSON array de calendários
    → stdout: JSON {"meetings": [...]} ou {"error": "..."}

  _renderMenu()
    → Separa eventos timed vs all-day
    → todayFuture = timed filtrado por toDateString() === hoje
    → _panelMeeting respeita showTentativeInPanel (chronological vs accepted-only)
    → Eventos all-day vão pro topo de cada bucket com badge ◼, nunca
      competem pelo slot do painel nem disparam conflito
    → Detecta conflitos (apenas timed events)
    → Preenche sub-menus (24h, 3d, 7d) com all-day prepended

  _updateDisplay()  (precedência, de cima pra baixo)
    → _lastError                          → label "⚠"
    → !showInPanel                        → hide_applet_label(true)
    → !_panelMeeting + _hasFutureMeetings → label "✓"
    → !_panelMeeting                      → label "Sem reuniões" / "—" se hidden
    → hiddenMode                          → label "⏱ countdown" (sem assunto)
    → hideSubject                         → label "horário + countdown" (sem nome)
    → marqueeEnabled + label longo        → _startMarquee() [label estática]
    → timerPosition "start"/"end"         → posição do horário no label normal

  Marquee (scrolling) — v2.5.3 char-step (revertido após pixel falhar em GJS):
    _startMarquee()  → Mainloop.timeout_add(speedMs) rodando _tickMarquee
                       speedMs = max(50, round(550 / marqueeSpeed))
                       aplica min-width + font-family:monospace via set_style
                       para o ícone vizinho não pular
    _stopMarquee()   → remove timer, limpa estilo e classe CSS
    _tickMarquee()   → fatia (padded + text).slice(offset, offset + max),
                       set_applet_label(slice), offset = (offset+1) % padded.length
    Label estática (horário de término, não countdown) → scroll não reseta a cada 30s.

  Notificações (D-Bus org.freedesktop.Notifications via Gio.DBusProxy):
    _setupNotifications()           proxy + assinatura ActionInvoked
    _checkUpcomingNotification()    respeita _snoozeUntil[mkey] antes de disparar
    _onNotificationAction()         "snooze-5" / "snooze-15" / "dismiss"
    Fallback: notify-send se proxy falhar.

  _openSettings()
    → ["xlet-settings", "applet", UUID, "--id", String(id)]
    → IMPORTANTE: instance_id é FLAG --id, NÃO argumento posicional
    → Fallback: cinnamon-settings applets UUID

  Timers (todos removidos em on_applet_removed_from_panel):
    GLib.SOURCE_CONTINUE / GLib.SOURCE_REMOVE (padrão cinnamon-spices)
    _refreshTimer  → Mainloop.timeout_add_seconds(refreshInterval * 60)
    _notifyTimer   → Mainloop.timeout_add_seconds(30)
    _marqueeTimer  → Mainloop.timeout_add(speedMs)
```

### fetch_meetings.py (Python 3, ~363 linhas)

- Recebe lista de calendários via **stdin** (JSON)
- Para cada calendário habilitado: baixa ICS via `urllib.request`
- Parse via `icalendar` + `recurring_ical_events` (se disponível) ou fallback regex builtin
- Suporta `VALUE=DATE` em ambos os parsers → `is_all_day=true` + start/end como `YYYY-MM-DD`
- Extrai status: `X-MICROSOFT-CDO-BUSYSTATUS` (TENTATIVE/BUSY/OOF/FREE) e `STATUS`
- Detecta join URLs (Teams, Google Meet, Zoom, Whereby) via regex
- Filtra janela: agora até +7 dias
- Saída: `{"meetings": [{uid, subject, start, end, location, join_url, status, is_all_day, calendar_name, calendar_color}]}`
- Warnings separados de errors (permite reuniões parciais com avisos)

---

## Configurações (settings-schema.json)

| Chave                    | Tipo        | Padrão  | Descrição                                              |
|--------------------------|-------------|---------|--------------------------------------------------------|
| calendars                | list        | []      | URLs ICS — colunas: Active, Name, URL, Color (string)  |
| show-in-panel            | switch      | true    | Exibe texto no painel                                  |
| label-max-chars          | spinbutton  | 40      | Máx caracteres no label                                |
| timer-position           | combobox    | "start" | Horário antes/depois do nome                           |
| marquee-enabled          | switch      | false   | Texto rolante para nomes longos                        |
| marquee-speed            | spinbutton  | 4       | Velocidade scroll (level 1–20; 1=slow, 20=fast)        |
| show-tentative           | switch      | true    | Mostra reuniões tentativas no popup                    |
| show-tentative-in-panel  | switch      | true    | OFF → painel só mostra accepted (pula tentatives)      |
| hidden-mode              | switch      | false   | Modo oculto: só countdown                              |
| hide-subject             | switch      | false   | Menos drástico que hidden — esconde só o nome          |
| notify-enabled           | switch      | true    | Notificar antes da reunião                             |
| notify-before            | spinbutton  | 30      | Minutos de antecedência                                |
| notify-conflicts         | switch      | true    | Notificar conflitos (urgency=critical)                 |
| refresh-interval         | spinbutton  | 5       | Intervalo de atualização (minutos)                     |

**combobox timer-position:** `{"Before meeting name": "start", "After meeting name": "end"}`  
Em `applet.js`: `this.timerPosition !== "end"` → posição antes.

A página **Help** do schema é populada com itens `type: "label"` (legenda
dos ícones de status, indicadores do painel, dicas, link do projeto) — não
há código de help no popup, só no Settings.

---

## Comportamentos chave implementados

### Day boundary (reunião do dia seguinte nunca aparece no painel)
```javascript
let todayStr      = new Date().toDateString();
let todayFuture   = future.filter(m => new Date(m.start).toDateString() === todayStr);
let nextAccepted  = todayFuture.find(m => m.status !== "tentative") || null;
let earliestToday = todayFuture[0] || null;
this._panelMeeting      = this._inProgress
    || (this.showTentativeInPanel !== false ? earliestToday : nextAccepted);
this._hasFutureMeetings = future.length > 0;
```
Quando `_panelMeeting = null` mas `_hasFutureMeetings = true` → painel mostra `✓`.

### Timer position
- `timerPosition = "start"` (padrão): `14:30  Nome da Reunião` / `◎ (5 min atrás)  Nome`
- `timerPosition = "end"`: `Nome da Reunião  14:30` / `◎ Nome  (5 min atrás)`

### Marquee (v2.5.3, char-step revivido)
- Só ativa quando `marqueeEnabled = true` E `staticLabel.length > labelMaxChars`
- Label estática = nome + horário de término (sem countdown → não reseta ao mudar)
- `_tickMarquee()`: `(padded + text).slice(offset, offset + max)`, offset % padded.length
- `min-width + font-family: monospace` no `_applet_label` mantém o ícone vizinho parado

### Snooze (v2.5.0+)
- Notificação D-Bus traz actions `snooze-5` / `snooze-15` / `dismiss`
- `_snoozeUntil[meetingKey] = Date.now() + N*60000`
- `_checkUpcomingNotification` ignora a reunião enquanto agora < _snoozeUntil

### Multi-instância (v2.5.0+)
- `metadata.json: "max-instances": "-1"` (ilimitado)
- Cada instância tem `instanceId` próprio → AppletSettings separado → calendários por instância

### Hide-subject (v2.5.0+)
- Modo intermediário entre exibição normal e Hidden Mode
- Mantém horário + countdown visíveis, esconde apenas o assunto da reunião
- Toggle no popup E em Settings → Privacy

### Detecção de conflitos
Dois eventos se conflitam se `startA < endB && startB < endA`, nenhum tem
status "free", e nenhum é all-day.

### Migração de config legada
Lê `~/.config/outlook-calendar-applet/config.json` (formato antigo) na primeira execução.

---

## i18n / gettext

- Domínio: `next-meeting@caio-hat`
- Localização: `~/.local/share/locale/<lang>/LC_MESSAGES/next-meeting@caio-hat.mo`
- `setup.sh` compila `.po → .mo` via `msgfmt`
- `applet.js`: `Gettext.bindtextdomain(UUID, ...)` + funções `_()`, `_f()`, `_np()`
- `fetch_meetings.py`: `gettext.translation(UUID, LOCALE_DIR, fallback=True)`
- Strings novas de v2.4/v2.5 (hide-subject, snooze actions, all-day badge,
  help labels) já traduzidas em `pt_BR.po`

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
1. ✅ **`icon.png`** — 48×48 px em `next-meeting@caio-hat/` (commit `f52dc0e` / `156ef88`)
2. **`screenshot.png`** — captura do applet em funcionamento, mesmo diretório
   - Tamanho sugerido pela comunidade: ~800×500 px
   - Mostrar idealmente painel + popup aberto com algumas reuniões

### Qualidade / UX
3. **Testes end-to-end** — instalar via `setup.sh`, validar:
   - `✓` aparece após último meeting do dia
   - Marquee rola corretamente (v2.5.3 char-step) sem resetar a cada 30s
   - `timer-position` muda a posição do horário
   - `hide-subject` e `hidden-mode` funcionam isolados e em conjunto com hidden
   - Notificação dispara com snooze-5/snooze-15/dismiss e respeita a janela
   - Múltiplas instâncias no painel com calendários diferentes
   - Configurações abrem via `xlet-settings` (botão "Settings" no popup)
4. **Testar com Google Calendar** — obter URL ICS pública e validar parse de eventos recorrentes
5. **Testar all-day events** — VTODO/feriados/PTO devem aparecer no popup com `◼`, nunca no painel

### PR para cinnamon-spices (futuro)
6. Ao submeter PR para `linuxmint/cinnamon-spices-applets`:
   - Copiar `next-meeting@caio-hat/` (com `info.json` + `icon.png` + `screenshot.png` + `files/`)
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
| Marquee pixel-based (v2.5.1/v2.5.2) congelava ou só repintava no hover | Reverter para char-step (v2.5.3) — `set_translation`/`set_x` em GJS+St eram sobrescritos pelo allocate do St.Label |
| `notify-send` perdia botões de ação | Migrar para `org.freedesktop.Notifications` via `Gio.DBusProxy` com `actions[]` + handler `ActionInvoked` |
| All-day events competiam pelo painel | Separar timed vs all-day em `_renderMenu`; all-day nunca entra em `_panelMeeting`/`_inProgress`/`_detectConflicts` |
| PNG renderizado preto + texto cortado | `convert` (ImageMagick) sem `librsvg2-bin` usa renderer MSVG quebrado → usar `cairosvg` (`pip --user`) ou instalar `librsvg2-bin` |
| Instalado em `~/.local/share/cinnamon/applets/` ficava obsoleto após edição no repo | Sempre rodar `bash setup.sh` + `cinnamon --replace` antes de debugar — `stat` ambos os arquivos para confirmar |

---

## Contato / histórico

Sessão de desenvolvimento anterior: `caio-hat/applet-cinnamon-outlookcalendar`
branch `claude/cinnamon-outlook-applet-TTEre` — contém todo o histórico de commits
desde a versão inicial (outlook-only) até a v2.3.0 (next-meeting genérico).
Versões v2.4+ vivem só neste repo.
