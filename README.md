# ⭐ Pontos da Família

App para os filhos ganharem pontos com tarefas e bom comportamento e os trocarem por prémios.

- **Pai/Mãe** (protegido por PIN): cria tarefas (diárias, em certos dias da semana ou num só dia) e prémios, valida o que os filhos marcaram, dá preço aos prémios sugeridos, dá bónus e tira pontos por mau comportamento.
- **Filhos** (cada um com o seu PIN): marcam as tarefas do dia, sugerem prémios e pedem prémios quando têm pontos suficientes.
- O saldo nunca desce abaixo de 0. As penalizações ficam no histórico.

Tudo gratuito: o código é servido pelo GitHub Pages e os dados ficam no Firebase (plano Spark, gratuito).

## Configuração (uma vez, ~10 minutos)

1. **Criar o projeto Firebase**: em <https://console.firebase.google.com> → *Adicionar projeto*. O Google Analytics não é preciso.
2. **Ativar o login**: *Build → Authentication → Começar → Email/Password → Ativar*.
3. **Criar a base de dados**: *Build → Firestore Database → Criar base de dados*, escolhe a região `eur3 (europe-west)` e o *modo de produção*.
4. **Regras de segurança**: em *Firestore → Regras*, substitui o conteúdo pelo de [`firestore.rules`](firestore.rules) e carrega em *Publicar*.
5. **Registar a app web**: em *Definições do projeto (⚙️) → Geral → As tuas apps → `</>`*, dá-lhe um nome e copia o objeto `firebaseConfig` para [`firebase-config.js`](firebase-config.js).
6. **Publicar**: no GitHub, em *Settings → Pages → Build and deployment*, escolhe *Deploy from a branch*, depois `main` / `/ (root)`. Ao fim de 1 a 2 minutos, a app fica em `https://<utilizador>.github.io/<repositorio>/`.
7. **Domínio autorizado**: em *Authentication → Settings → Authorized domains*, adiciona `<utilizador>.github.io`.

## Primeira utilização

1. Abre a app e carrega em **Criar conta da família** (email e password teus).
2. Escolhe o PIN do pai/mãe e adiciona os filhos, cada um com o seu PIN.
3. Em cada aparelho dos filhos, entra uma vez com a conta da família. A app lembra-se do perfil do filho; o modo pai pede sempre o PIN.
4. Dica: no telemóvel, usa *Partilhar → Adicionar ao ecrã principal* para a app ficar com ícone.

## Limitações a saber

- **Os PINs protegem o ecrã, não o servidor.** Todos os aparelhos usam a mesma conta da família, por isso alguém com conhecimentos técnicos e acesso à conta poderia alterar dados sem passar pela app. Para crianças chega. Se um dia não chegar, o passo seguinte é dar uma conta Firebase a cada filho e tornar as regras mais restritivas.
- As tarefas só podem ser marcadas no próprio dia. O pai/mãe pode validá-las mais tarde.
- O histórico mostra os últimos 500 registos.

## Testes locais (opcional)

```bash
npx firebase-tools emulators:start --only auth,firestore --project demo-pontos
python3 -m http.server 5173
# abrir http://127.0.0.1:5173/?emulator
```
