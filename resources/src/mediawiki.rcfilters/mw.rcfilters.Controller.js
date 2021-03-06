( function ( mw, $ ) {
	/* eslint no-underscore-dangle: "off" */
	/**
	 * Controller for the filters in Recent Changes
	 *
	 * @param {mw.rcfilters.dm.FiltersViewModel} filtersModel Filters view model
	 * @param {mw.rcfilters.dm.ChangesListViewModel} changesListModel Changes list view model
	 * @param {mw.rcfilters.dm.SavedQueriesModel} savedQueriesModel Saved queries model
	 */
	mw.rcfilters.Controller = function MwRcfiltersController( filtersModel, changesListModel, savedQueriesModel ) {
		this.filtersModel = filtersModel;
		this.changesListModel = changesListModel;
		this.savedQueriesModel = savedQueriesModel;
		this.requestCounter = 0;
		this.baseFilterState = {};
		this.uriProcessor = null;
		this.initializing = false;
	};

	/* Initialization */
	OO.initClass( mw.rcfilters.Controller );

	/**
	 * Initialize the filter and parameter states
	 *
	 * @param {Array} filterStructure Filter definition and structure for the model
	 * @param {Object} [namespaceStructure] Namespace definition
	 * @param {Object} [tagList] Tag definition
	 */
	mw.rcfilters.Controller.prototype.initialize = function ( filterStructure, namespaceStructure, tagList ) {
		var parsedSavedQueries,
			views = {},
			items = [],
			uri = new mw.Uri(),
			$changesList = $( '.mw-changeslist' ).first().contents();

		// Prepare views
		if ( namespaceStructure ) {
			items = [];
			$.each( namespaceStructure, function ( namespaceID, label ) {
				// Build and clean up the individual namespace items definition
				items.push( {
					name: namespaceID,
					label: label || mw.msg( 'blanknamespace' ),
					description: '',
					identifiers: [
						( namespaceID < 0 || namespaceID % 2 === 0 ) ?
							'subject' : 'talk'
					],
					cssClass: 'mw-changeslist-ns-' + namespaceID
				} );
			} );

			views.namespaces = {
				title: mw.msg( 'namespaces' ),
				trigger: ':',
				groups: [ {
					// Group definition (single group)
					name: 'namespaces',
					type: 'string_options',
					title: mw.msg( 'namespaces' ),
					labelPrefixKey: { 'default': 'rcfilters-tag-prefix-namespace', inverted: 'rcfilters-tag-prefix-namespace-inverted' },
					separator: ';',
					fullCoverage: true,
					filters: items
				} ]
			};
		}
		if ( tagList ) {
			views.tags = {
				title: mw.msg( 'rcfilters-view-tags' ),
				trigger: '#',
				groups: [ {
					// Group definition (single group)
					name: 'tagfilter', // Parameter name
					type: 'string_options',
					title: 'rcfilters-view-tags', // Message key
					labelPrefixKey: 'rcfilters-tag-prefix-tags',
					separator: '|',
					fullCoverage: false,
					filters: tagList
				} ]
			};
		}

		// Initialize the model
		this.filtersModel.initializeFilters( filterStructure, views );

		this._buildBaseFilterState();

		this.uriProcessor = new mw.rcfilters.UriProcessor(
			this.filtersModel
		);

		try {
			parsedSavedQueries = JSON.parse( mw.user.options.get( 'rcfilters-saved-queries' ) || '{}' );
		} catch ( err ) {
			parsedSavedQueries = {};
		}

		// The queries are saved in a minimized state, so we need
		// to send over the base state so the saved queries model
		// can normalize them per each query item
		this.savedQueriesModel.initialize(
			parsedSavedQueries,
			this._getBaseFilterState()
		);

		// Check whether we need to load defaults.
		// We do this by checking whether the current URI query
		// contains any parameters recognized by the system.
		// If it does, we load the given state.
		// If it doesn't, we have no values at all, and we assume
		// the user loads the base-page and we load defaults.
		// Defaults should only be applied on load (if necessary)
		// or on request
		this.initializing = true;
		if (
			this.savedQueriesModel.getDefault() &&
			!this.uriProcessor.doesQueryContainRecognizedParams( uri.query )
		) {
			// We have defaults from a saved query.
			// We will load them straight-forward (as if
			// they were clicked in the menu) so we trigger
			// a full ajax request and change of URL
			this.applySavedQuery( this.savedQueriesModel.getDefault() );
		} else {
			// There are either recognized parameters in the URL
			// or there are none, but there is also no default
			// saved query (so defaults are from the backend)
			// We want to update the state but not fetch results
			// again
			this.updateStateFromUrl( false );

			// Update the changes list with the existing data
			// so it gets processed
			this.changesListModel.update(
				$changesList.length ? $changesList : 'NO_RESULTS',
				$( 'fieldset.rcoptions' ).first()
			);
		}

		this.initializing = false;
		this.switchView( 'default' );
	};

	/**
	 * Switch the view of the filters model
	 *
	 * @param {string} view Requested view
	 */
	mw.rcfilters.Controller.prototype.switchView = function ( view ) {
		this.filtersModel.switchView( view );
	};

	/**
	 * Reset to default filters
	 */
	mw.rcfilters.Controller.prototype.resetToDefaults = function () {
		this.uriProcessor.updateModelBasedOnQuery( this._getDefaultParams() );
		this.updateChangesList();
	};

	/**
	 * Empty all selected filters
	 */
	mw.rcfilters.Controller.prototype.emptyFilters = function () {
		var highlightedFilterNames = this.filtersModel
			.getHighlightedItems()
			.map( function ( filterItem ) { return { name: filterItem.getName() }; } );

		this.filtersModel.emptyAllFilters();
		this.filtersModel.clearAllHighlightColors();
		// Check all filter interactions
		this.filtersModel.reassessFilterInteractions();

		this.updateChangesList();

		if ( highlightedFilterNames ) {
			this._trackHighlight( 'clearAll', highlightedFilterNames );
		}
	};

	/**
	 * Update the selected state of a filter
	 *
	 * @param {string} filterName Filter name
	 * @param {boolean} [isSelected] Filter selected state
	 */
	mw.rcfilters.Controller.prototype.toggleFilterSelect = function ( filterName, isSelected ) {
		var filterItem = this.filtersModel.getItemByName( filterName );

		if ( !filterItem ) {
			// If no filter was found, break
			return;
		}

		isSelected = isSelected === undefined ? !filterItem.isSelected() : isSelected;

		if ( filterItem.isSelected() !== isSelected ) {
			this.filtersModel.toggleFilterSelected( filterName, isSelected );

			this.updateChangesList();

			// Check filter interactions
			this.filtersModel.reassessFilterInteractions( filterItem );
		}
	};

	/**
	 * Clear both highlight and selection of a filter
	 *
	 * @param {string} filterName Name of the filter item
	 */
	mw.rcfilters.Controller.prototype.clearFilter = function ( filterName ) {
		var filterItem = this.filtersModel.getItemByName( filterName ),
			isHighlighted = filterItem.isHighlighted();

		if ( filterItem.isSelected() || isHighlighted ) {
			this.filtersModel.clearHighlightColor( filterName );
			this.filtersModel.toggleFilterSelected( filterName, false );
			this.updateChangesList();
			this.filtersModel.reassessFilterInteractions( filterItem );
		}

		if ( isHighlighted ) {
			this._trackHighlight( 'clear', filterName );
		}
	};

	/**
	 * Toggle the highlight feature on and off
	 */
	mw.rcfilters.Controller.prototype.toggleHighlight = function () {
		this.filtersModel.toggleHighlight();
		this._updateURL();

		if ( this.filtersModel.isHighlightEnabled() ) {
			mw.hook( 'RcFilters.highlight.enable' ).fire();
		}
	};

	/**
	 * Toggle the namespaces inverted feature on and off
	 */
	mw.rcfilters.Controller.prototype.toggleInvertedNamespaces = function () {
		this.filtersModel.toggleInvertedNamespaces();
		this.updateChangesList();
	};

	/**
	 * Set the highlight color for a filter item
	 *
	 * @param {string} filterName Name of the filter item
	 * @param {string} color Selected color
	 */
	mw.rcfilters.Controller.prototype.setHighlightColor = function ( filterName, color ) {
		this.filtersModel.setHighlightColor( filterName, color );
		this._updateURL();
		this._trackHighlight( 'set', { name: filterName, color: color } );
	};

	/**
	 * Clear highlight for a filter item
	 *
	 * @param {string} filterName Name of the filter item
	 */
	mw.rcfilters.Controller.prototype.clearHighlightColor = function ( filterName ) {
		this.filtersModel.clearHighlightColor( filterName );
		this._updateURL();
		this._trackHighlight( 'clear', filterName );
	};

	/**
	 * Save the current model state as a saved query
	 *
	 * @param {string} [label] Label of the saved query
	 */
	mw.rcfilters.Controller.prototype.saveCurrentQuery = function ( label ) {
		var highlightedItems = {},
			highlightEnabled = this.filtersModel.isHighlightEnabled();

		// Prepare highlights
		this.filtersModel.getHighlightedItems().forEach( function ( item ) {
			highlightedItems[ item.getName() ] = highlightEnabled ?
				item.getHighlightColor() : null;
		} );
		// These are filter states; highlight is stored as boolean
		highlightedItems.highlight = this.filtersModel.isHighlightEnabled();

		// Add item
		this.savedQueriesModel.addNewQuery(
			label || mw.msg( 'rcfilters-savedqueries-defaultlabel' ),
			{
				filters: this.filtersModel.getSelectedState(),
				highlights: highlightedItems,
				invert: this.filtersModel.areNamespacesInverted()
			}
		);

		// Save item
		this._saveSavedQueries();
	};

	/**
	 * Remove a saved query
	 *
	 * @param {string} queryID Query id
	 */
	mw.rcfilters.Controller.prototype.removeSavedQuery = function ( queryID ) {
		this.savedQueriesModel.removeQuery( queryID );

		this._saveSavedQueries();
	};

	/**
	 * Rename a saved query
	 *
	 * @param {string} queryID Query id
	 * @param {string} newLabel New label for the query
	 */
	mw.rcfilters.Controller.prototype.renameSavedQuery = function ( queryID, newLabel ) {
		var queryItem = this.savedQueriesModel.getItemByID( queryID );

		if ( queryItem ) {
			queryItem.updateLabel( newLabel );
		}
		this._saveSavedQueries();
	};

	/**
	 * Set a saved query as default
	 *
	 * @param {string} queryID Query Id. If null is given, default
	 *  query is reset.
	 */
	mw.rcfilters.Controller.prototype.setDefaultSavedQuery = function ( queryID ) {
		this.savedQueriesModel.setDefault( queryID );
		this._saveSavedQueries();
	};

	/**
	 * Load a saved query
	 *
	 * @param {string} queryID Query id
	 */
	mw.rcfilters.Controller.prototype.applySavedQuery = function ( queryID ) {
		var data, highlights,
			queryItem = this.savedQueriesModel.getItemByID( queryID );

		if ( queryItem ) {
			data = queryItem.getData();
			highlights = data.highlights;

			// Backwards compatibility; initial version mispelled 'highlight' with 'highlights'
			highlights.highlight = highlights.highlights || highlights.highlight;

			// Update model state from filters
			this.filtersModel.toggleFiltersSelected( data.filters );

			// Update namespace inverted property
			this.filtersModel.toggleInvertedNamespaces( !!Number( data.invert ) );

			// Update highlight state
			this.filtersModel.toggleHighlight( !!Number( highlights.highlight ) );
			this.filtersModel.getItems().forEach( function ( filterItem ) {
				var color = highlights[ filterItem.getName() ];
				if ( color ) {
					filterItem.setHighlightColor( color );
				} else {
					filterItem.clearHighlightColor();
				}
			} );

			// Check all filter interactions
			this.filtersModel.reassessFilterInteractions();

			this.updateChangesList();
		}
	};

	/**
	 * Check whether the current filter and highlight state exists
	 * in the saved queries model.
	 *
	 * @return {boolean} Query exists
	 */
	mw.rcfilters.Controller.prototype.findQueryMatchingCurrentState = function () {
		var highlightedItems = {};

		// Prepare highlights of the current query
		this.filtersModel.getItemsSupportingHighlights().forEach( function ( item ) {
			highlightedItems[ item.getName() ] = item.getHighlightColor();
		} );
		highlightedItems.highlight = this.filtersModel.isHighlightEnabled();

		return this.savedQueriesModel.findMatchingQuery(
			{
				filters: this.filtersModel.getSelectedState(),
				highlights: highlightedItems,
				invert: this.filtersModel.areNamespacesInverted()
			}
		);
	};

	/**
	 * Get an object representing the base state of parameters
	 * and highlights.
	 *
	 * This is meant to make sure that the saved queries that are
	 * in memory are always the same structure as what we would get
	 * by calling the current model's "getSelectedState" and by checking
	 * highlight items.
	 *
	 * In cases where a user saved a query when the system had a certain
	 * set of filters, and then a filter was added to the system, we want
	 * to make sure that the stored queries can still be comparable to
	 * the current state, which means that we need the base state for
	 * two operations:
	 *
	 * - Saved queries are stored in "minimal" view (only changed filters
	 *   are stored); When we initialize the system, we merge each minimal
	 *   query with the base state (using 'getNormalizedFilters') so all
	 *   saved queries have the exact same structure as what we would get
	 *   by checking the getSelectedState of the filter.
	 * - When we save the queries, we minimize the object to only represent
	 *   whatever has actually changed, rather than store the entire
	 *   object. To check what actually is different so we can store it,
	 *   we need to obtain a base state to compare against, this is
	 *   what #_getMinimalFilterList does
	 */
	mw.rcfilters.Controller.prototype._buildBaseFilterState = function () {
		var defaultParams = this.filtersModel.getDefaultParams(),
			highlightedItems = {};

		// Prepare highlights
		this.filtersModel.getItemsSupportingHighlights().forEach( function ( item ) {
			highlightedItems[ item.getName() ] = null;
		} );
		highlightedItems.highlight = false;

		this.baseFilterState = {
			filters: this.filtersModel.getFiltersFromParameters( defaultParams ),
			highlights: highlightedItems,
			invert: false
		};
	};

	/**
	 * Get an object representing the base filter state of both
	 * filters and highlights. The structure is similar to what we use
	 * to store each query in the saved queries object:
	 * {
	 *    filters: {
	 *        filterName: (bool)
	 *    },
	 *    highlights: {
	 *        filterName: (string|null)
	 *    }
	 * }
	 *
	 * @return {Object} Object representing the base state of
	 *  parameters and highlights
	 */
	mw.rcfilters.Controller.prototype._getBaseFilterState = function () {
		return this.baseFilterState;
	};

	/**
	 * Get an object that holds only the parameters and highlights that have
	 * values different than the base default value.
	 *
	 * This is the reverse of the normalization we do initially on loading and
	 * initializing the saved queries model.
	 *
	 * @param {Object} valuesObject Object representing the state of both
	 *  filters and highlights in its normalized version, to be minimized.
	 * @return {Object} Minimal filters and highlights list
	 */
	mw.rcfilters.Controller.prototype._getMinimalFilterList = function ( valuesObject ) {
		var result = { filters: {}, highlights: {} },
			baseState = this._getBaseFilterState();

		// XOR results
		$.each( valuesObject.filters, function ( name, value ) {
			if ( baseState.filters !== undefined && baseState.filters[ name ] !== value ) {
				result.filters[ name ] = value;
			}
		} );

		$.each( valuesObject.highlights, function ( name, value ) {
			if ( baseState.highlights !== undefined && baseState.highlights[ name ] !== value ) {
				result.highlights[ name ] = value;
			}
		} );

		return result;
	};

	/**
	 * Save the current state of the saved queries model with all
	 * query item representation in the user settings.
	 */
	mw.rcfilters.Controller.prototype._saveSavedQueries = function () {
		var stringified,
			state = this.savedQueriesModel.getState(),
			controller = this;

		// Minimize before save
		$.each( state.queries, function ( queryID, info ) {
			state.queries[ queryID ].data = controller._getMinimalFilterList( info.data );
		} );

		// Stringify state
		stringified = JSON.stringify( state );

		if ( stringified.length > 65535 ) {
			// Sanity check, since the preference can only hold that.
			return;
		}

		// Save the preference
		new mw.Api().saveOption( 'rcfilters-saved-queries', stringified );
		// Update the preference for this session
		mw.user.options.set( 'rcfilters-saved-queries', stringified );
	};

	/**
	 * Synchronize the URL with the current state of the filters
	 * without adding an history entry.
	 */
	mw.rcfilters.Controller.prototype.replaceUrl = function () {
		mw.rcfilters.UriProcessor.static.replaceState( this._getUpdatedUri() );
	};

	/**
	 * Update filter state (selection and highlighting) based
	 * on current URL values.
	 *
	 * @param {boolean} [fetchChangesList=true] Fetch new results into the changes
	 *  list based on the updated model.
	 */
	mw.rcfilters.Controller.prototype.updateStateFromUrl = function ( fetchChangesList ) {
		fetchChangesList = fetchChangesList === undefined ? true : !!fetchChangesList;

		this.uriProcessor.updateModelBasedOnQuery( new mw.Uri().query );

		// Only update and fetch new results if it is requested
		if ( fetchChangesList ) {
			this.updateChangesList();
		}
	};

	/**
	 * Update the list of changes and notify the model
	 *
	 * @param {Object} [params] Extra parameters to add to the API call
	 */
	mw.rcfilters.Controller.prototype.updateChangesList = function ( params ) {
		this._updateURL( params );
		this.changesListModel.invalidate();
		this._fetchChangesList()
			.then(
				// Success
				function ( pieces ) {
					var $changesListContent = pieces.changes,
						$fieldset = pieces.fieldset;
					this.changesListModel.update( $changesListContent, $fieldset );
				}.bind( this )
				// Do nothing for failure
			);
	};

	/**
	 * Get an object representing the default parameter state, whether
	 * it is from the model defaults or from the saved queries.
	 *
	 * @return {Object} Default parameters
	 */
	mw.rcfilters.Controller.prototype._getDefaultParams = function () {
		var data, queryHighlights,
			savedParams = {},
			savedHighlights = {},
			defaultSavedQueryItem = this.savedQueriesModel.getItemByID( this.savedQueriesModel.getDefault() );

		if ( mw.config.get( 'wgStructuredChangeFiltersEnableSaving' ) &&
			defaultSavedQueryItem ) {

			data = defaultSavedQueryItem.getData();

			queryHighlights = data.highlights || {};
			savedParams = this.filtersModel.getParametersFromFilters( data.filters || {} );

			// Translate highlights to parameters
			savedHighlights.highlight = String( Number( queryHighlights.highlight ) );
			$.each( queryHighlights, function ( filterName, color ) {
				if ( filterName !== 'highlights' ) {
					savedHighlights[ filterName + '_color' ] = color;
				}
			} );

			return $.extend( true, {}, savedParams, savedHighlights, { invert: data.invert } );
		}

		return $.extend(
			{ highlight: '0' },
			this.filtersModel.getDefaultParams()
		);
	};

	/**
	 * Get an object representing the default parameter state, whether
	 * it is from the model defaults or from the saved queries.
	 *
	 * @return {Object} Default parameters
	 */
	mw.rcfilters.Controller.prototype._getDefaultParams = function () {
		var data, queryHighlights,
			savedParams = {},
			savedHighlights = {},
			defaultSavedQueryItem = this.savedQueriesModel.getItemByID( this.savedQueriesModel.getDefault() );

		if ( mw.config.get( 'wgStructuredChangeFiltersEnableSaving' ) &&
			defaultSavedQueryItem ) {

			data = defaultSavedQueryItem.getData();

			queryHighlights = data.highlights || {};
			savedParams = this.filtersModel.getParametersFromFilters( data.filters || {} );

			// Translate highlights to parameters
			savedHighlights.highlight = String( Number( queryHighlights.highlight ) );
			$.each( queryHighlights, function ( filterName, color ) {
				if ( filterName !== 'highlights' ) {
					savedHighlights[ filterName + '_color' ] = color;
				}
			} );

			return $.extend( true, {}, savedParams, savedHighlights );
		}

		return this.filtersModel.getDefaultParams();
	};

	/**
	 * Update the URL of the page to reflect current filters
	 *
	 * This should not be called directly from outside the controller.
	 * If an action requires changing the URL, it should either use the
	 * highlighting actions below, or call #updateChangesList which does
	 * the uri corrections already.
	 *
	 * @param {Object} [params] Extra parameters to add to the API call
	 */
	mw.rcfilters.Controller.prototype._updateURL = function ( params ) {
		var currentUri = new mw.Uri(),
			updatedUri = this._getUpdatedUri();

		updatedUri.extend( params || {} );

		if (
			this.uriProcessor.getVersion( currentUri.query ) !== 2 ||
			this.uriProcessor.isNewState( currentUri.query, updatedUri.query )
		) {
			mw.rcfilters.UriProcessor.static.replaceState( updatedUri );
		}
	};

	/**
	 * Get an updated mw.Uri object based on the model state
	 *
	 * @return {mw.Uri} Updated Uri
	 */
	mw.rcfilters.Controller.prototype._getUpdatedUri = function () {
		var uri = new mw.Uri();

		// Minimize url
		uri.query = this.uriProcessor.minimizeQuery(
			$.extend(
				true,
				{},
				// We want to retain unrecognized params
				// The uri params from model will override
				// any recognized value in the current uri
				// query, retain unrecognized params, and
				// the result will then be minimized
				uri.query,
				this.uriProcessor.getUriParametersFromModel(),
				{ urlversion: '2' }
			)
		);

		return uri;
	};

	/**
	 * Fetch the list of changes from the server for the current filters
	 *
	 * @return {jQuery.Promise} Promise object that will resolve with the changes list
	 *  or with a string denoting no results.
	 */
	mw.rcfilters.Controller.prototype._fetchChangesList = function () {
		var uri = this._getUpdatedUri(),
			requestId = ++this.requestCounter,
			latestRequest = function () {
				return requestId === this.requestCounter;
			}.bind( this );

		return $.ajax( uri.toString(), { contentType: 'html' } )
			.then(
				// Success
				function ( html ) {
					var $parsed;
					if ( !latestRequest() ) {
						return $.Deferred().reject();
					}

					$parsed = $( $.parseHTML( html ) );

					return {
						// Changes list
						changes: $parsed.find( '.mw-changeslist' ).first().contents(),
						// Fieldset
						fieldset: $parsed.find( 'fieldset.rcoptions' ).first()
					};
				},
				// Failure
				function ( responseObj ) {
					var $parsed;

					if ( !latestRequest() ) {
						return $.Deferred().reject();
					}

					$parsed = $( $.parseHTML( responseObj.responseText ) );

					// Force a resolve state to this promise
					return $.Deferred().resolve( {
						changes: 'NO_RESULTS',
						fieldset: $parsed.find( 'fieldset.rcoptions' ).first()
					} ).promise();
				}
			);
	};

	/**
	 * Track usage of highlight feature
	 *
	 * @param {string} action
	 * @param {array|object|string} filters
	 */
	mw.rcfilters.Controller.prototype._trackHighlight = function ( action, filters ) {
		filters = typeof filters === 'string' ? { name: filters } : filters;
		filters = !Array.isArray( filters ) ? [ filters ] : filters;
		mw.track(
			'event.ChangesListHighlights',
			{
				action: action,
				filters: filters,
				userId: mw.user.getId()
			}
		);
	};

}( mediaWiki, jQuery ) );
