// Configuração da app web do Firebase (Consola Firebase → Configurações do projeto → Seus apps).
// Estes valores não são secretos: a proteção dos dados vem das regras em firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyAp0km_52mpcdlDX4fh_sQSi8zG0Umly8c",
  authDomain: "pontos-familia-de027.firebaseapp.com",
  projectId: "pontos-familia-de027",
  storageBucket: "pontos-familia-de027.firebasestorage.app",
  messagingSenderId: "830850678152",
  appId: "1:830850678152:web:023e574c3aafc5a7428e3d",
};

// Chave pública para notificações (Configurações do projeto → Cloud Messaging → Certificados push da Web).
export const vapidKey = "BCVFMDLn_fk1oPRKMd6JylLjGtQALNUDRh6G0kRsqPQYHH4tvfGpsVpKC0R7MTCTuX_m1HKXjhydAs9x55ULMuE";
