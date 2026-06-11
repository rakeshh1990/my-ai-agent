const chatContainer = document.getElementById('chatContainer');
const chatForm = document.getElementById('chatForm');
const promptInput = document.getElementById('promptInput');
const sendButton = document.getElementById('sendButton');
const clearButton = document.getElementById('clearButton');
const statusBar = document.getElementById('statusBar');
const statusText = document.getElementById('statusText');

function renderMessage(message) {
  const element = document.createElement('div');
  element.className = `message ${message.role}`;
  element.textContent = message.text;
  return element;
}

function setLoading(loading) {
  if (loading) {
    clearButton.disabled = true;
    promptInput.disabled = true;
    sendButton.disabled = true;
    statusText.textContent = 'Assistant is typing…';
    statusBar.classList.remove('hidden');
  } else {
    clearButton.disabled = false;
    promptInput.disabled = false;
    sendButton.disabled = false;
    statusBar.classList.add('hidden');
  }
}

async function loadHistory() {
  const response = await fetch('/api/history');
  if (!response.ok) {
    console.error('Failed to load history');
    return;
  }
  const data = await response.json();
  chatContainer.innerHTML = '';
  data.history.forEach((message) => {
    chatContainer.appendChild(renderMessage(message));
  });
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function typeText(element, text) {
  return new Promise((resolve) => {
    element.textContent = '';
    let index = 0;
    const interval = setInterval(() => {
      element.textContent += text[index++] || '';
      chatContainer.scrollTop = chatContainer.scrollHeight;
      if (index >= text.length) {
        clearInterval(interval);
        resolve();
      }
    }, 20);
  });
}

async function sendMessage(text) {
  setLoading(true);
  const assistantBubble = renderMessage({ role: 'assistant', text: '...' });
  assistantBubble.classList.add('assistant-placeholder');
  chatContainer.appendChild(assistantBubble);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    const data = await response.json();
    if (!response.ok) {
      assistantBubble.remove();
      alert(data.error || 'Failed to send message');
      return;
    }

    const assistantText = data.text || '';
    await typeText(assistantBubble, assistantText);
  } catch (error) {
    assistantBubble.remove();
    alert(error.message || 'Failed to reach the assistant');
  } finally {
    setLoading(false);
  }
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = promptInput.value.trim();
  if (!text) return;
  promptInput.value = '';
  chatContainer.appendChild(renderMessage({ role: 'user', text }));
  chatContainer.scrollTop = chatContainer.scrollHeight;
  sendMessage(text);
});

promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

clearButton.addEventListener('click', async () => {
  if (!confirm('Clear the current chat history?')) return;
  setLoading(true);
  await fetch('/api/clear', { method: 'POST' });
  chatContainer.innerHTML = '';
  setLoading(false);
});

window.addEventListener('load', loadHistory);
