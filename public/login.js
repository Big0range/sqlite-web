const form = document.querySelector("#login-form");
const message = document.querySelector("#login-message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  const values = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || "登录失败，请稍后重试。");
    }
    window.location.assign("/");
  } catch (error) {
    message.textContent = error.message;
  }
});
