/**
 * MyST sub-ref Role Plugin
 *
 * This plugin provides a sub-ref role that returns today's date.
 *
 * Usage in MyST:
 * {sub-ref}`today`
 */

const subRefRole = {
  // The name used to invoke the role
  name: 'sub-ref',

  // Documentation shown when users discover the role
  doc: 'A role that returns today\'s date when given "today" as the argument.',

  /**
   * The run function processes the role and returns AST nodes
   *
   * @param {Object} data - Contains the content between backticks
   * @returns {Array} Array of AST nodes to insert
   */
  run(data) {
    console.log('[sub-ref plugin] Called with data:', data);

    // Access the role content from node.value
    const content = data?.node?.value || data?.arg || '';
    console.log('[sub-ref plugin] Content:', content);

    // If the content is "today", return today's date
    if (content === 'today') {
      const today = new Date();
      const formattedDate = today.toISOString().split('T')[0]; // YYYY-MM-DD format
      console.log('[sub-ref plugin] Returning date:', formattedDate);

      return [
        {
          type: 'text',
          value: formattedDate,
        },
      ];
    }

    // For other content, just return it as plain text
    console.log('[sub-ref plugin] Returning content as-is');
    return [
      {
        type: 'text',
        value: content || '',
      },
    ];
  },
};

// Export the plugin with the role
const plugin = {
  name: 'Sub-ref Plugin',
  roles: [subRefRole],
};

export default plugin;
