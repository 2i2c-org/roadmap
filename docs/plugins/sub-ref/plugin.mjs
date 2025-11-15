const subRefRole = {
  name: 'sub-ref',
  doc: 'Return a small bit of dynamically generated text (e.g. today\'s date).',
  run(data) {
    const value = data?.node?.value || data?.arg || '';
    if (value === 'today') {
      return [
        {
          type: 'text',
          value: new Date().toISOString().split('T')[0],
        },
      ];
    }
    return [
      {
        type: 'text',
        value: value || '',
      },
    ];
  },
};

export default {
  name: 'Sub-ref Plugin',
  roles: [subRefRole],
};
