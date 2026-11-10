if (window.firstDynamicValue !== 42) throw Error('Classic scripts ran out of order');
window.scriptOrder.push('second');
