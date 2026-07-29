// 화면 전환 로직

function showScreen(screenId) {
  document.querySelectorAll(".screen").forEach((el) => {
    el.classList.toggle("hidden", el.id !== screenId);
  });
}

document.getElementById("btn-start").addEventListener("click", () => {
  showScreen("screen-board");
});
