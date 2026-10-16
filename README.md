# ⭐ Pontos da Família

App para os filhos ganharem pontos com tarefas e bom comportamento e os trocarem por prémios.

- **Pai/Mãe** (protegido por PIN): cria tarefas (diárias, em certos dias da semana ou num só dia) e prémios, valida o que os filhos marcaram, dá preço aos prémios sugeridos, dá bónus e tira pontos por mau comportamento.
- **Filhos** (cada um com o seu PIN): marcam as tarefas do dia, sugerem prémios e pedem prémios quando têm pontos suficientes.
- O saldo nunca desce abaixo de 0. As penalizações ficam no histórico.

Tudo gratuito: o código é servido pelo GitHub Pages e os dados ficam no Firebase (plano Spark, gratuito).

## Configuração (uma vez, ~10 minutos)

1. **Criar o projeto Firebase**: em <https://console.firebase.google.com> → *Adicionar projeto*. O Google Analytics não é preciso.
2. **Ativar o login**: *Authentication → Método de login*: ativa **E-mail/senha** e **Anônimo** (o anónimo é o que deixa os filhos entrar só com o link e o PIN).
3. **Criar a base de dados**: *Build → Firestore Database → Criar base de dados*, escolhe a região `eur3 (europe-west)` e o *modo de produção*.
4. **Regras de segurança**: em *Firestore → Regras*, substitui o conteúdo pelo de [`firestore.rules`](firestore.rules) e carrega em *Publicar*.
5. **Registar a app web**: em *Definições do projeto (⚙️) → Geral → As tuas apps → `</>`*, dá-lhe um nome e copia o objeto `firebaseConfig` para [`firebase-config.js`](firebase-config.js).
6. **Publicar**: no GitHub, em *Settings → Pages → Build and deployment*, escolhe *Deploy from a branch*, depois `main` / `/ (root)`. Ao fim de 1 a 2 minutos, a app fica em `https://<utilizador>.github.io/<repositorio>/`.
7. **Domínio autorizado**: em *Authentication → Settings → Authorized domains*, adiciona `<utilizador>.github.io`.

## Primeira utilização

1. Abre a app e carrega em **Criar conta da família** (email e password teus).
2. Escolhe o PIN do pai/mãe e adiciona os filhos, cada um com o seu PIN.
3. Para cada aparelho dos filhos: em ⚙️ Definições → **Ligar aparelho de um filho**, envia o link para esse aparelho e abre-o lá. Os filhos não precisam de email nem password — só do PIN, que é pedido sempre que a app abre.
   - Para desligar os aparelhos (por exemplo, se o link chegar a quem não devia), usa **Desligar todos**: o link antigo deixa de funcionar.
4. Dica: no telemóvel, usa *Partilhar → Adicionar ao ecrã principal* para a app ficar com ícone.

## Limitações a saber

- **Os PINs protegem o ecrã, não o servidor.** Todos os aparelhos ligados têm acesso aos dados da família, por isso alguém com conhecimentos técnicos e acesso à conta poderia alterar dados sem passar pela app. Para crianças chega. Se um dia não chegar, o passo seguinte é dar uma conta Firebase a cada filho e tornar as regras mais restritivas.
- Os filhos podem marcar tarefas dos últimos 3 dias (o pai/mãe muda isto em ⚙️ Definições, de 0 a 14 dias). O pai/mãe valida quando quiser.
- O histórico mostra os últimos 500 registos.

## Testes locais (opcional)

```bash
npx firebase-tools emulators:start --only auth,firestore --project demo-pontos
python3 -m http.server 5173
# abrir http://127.0.0.1:5173/?emulator
```
