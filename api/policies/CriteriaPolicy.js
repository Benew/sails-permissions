/**
 * CriteriaPolicy
 * @depends PermissionPolicy
 *
 * Verify that the User fulfills permission 'where' conditions and attribute blacklist restrictions
 */
var wlFilter = require('waterline-criteria');
var _ = require('lodash');

module.exports = function(req, res, next) {
  var permissions = req.permissions;

  if (_.isEmpty(permissions)) {
    return next();
  }

  var action = PermissionService.getMethod(req);

  var body = req.body || req.query;

  // if we are creating, we don't need to query the db, just check the where clause vs the passed in data
  if (action === 'create') {
    if (!PermissionService.hasPassingCriteria(body, permissions, body)) {
      return res.forbidden({
        error: 'Can\'t create this object, because of failing where clause'
      });
    }
    return next();
  }

  // get all of the where clauses and blacklists into one flat array
  // if a permission has no criteria then it is always true
  var criteria = _.compact(_.flatten(
    _.map(permissions, function(permission) {
      if (_.isEmpty(permission.criteria)) {
        permission.criteria = [{
          where: {}
        }];
      }

      var criteriaList = permission.criteria;
      return _.map(criteriaList, function(criteria) {
        // ensure criteria.where is initialized
        criteria.where = criteria.where || {};

        if (permission.relation == 'owner') {
          criteria.where.owner = req.user.id;
        }

        return criteria;
      });
    })
  ));


  // set up response filters if we are not mutating an existing object
  if (!_.contains(['update', 'delete'], action)) {

    if (criteria.length) {
      bindResponsePolicy(req, res, criteria);
    }
    return next();
  }

  PermissionService.findTargetObjects(req)
    .then(function(objects) {

      // attributes are not important for a delete request
      if (action === 'delete') {
        body = undefined;
      }

      if (!PermissionService.hasPassingCriteria(objects, permissions, body, req.user.id)) {
        return res.forbidden({
          error: 'Can\'t ' + action + ', because of failing where clause or attribute permissions'
        });
      }

      next();
    })
    .catch(next);
};

function bindResponsePolicy(req, res, criteria) {
  res._ok = res.ok;

  res.ok = _.bind(responsePolicy, {
    req: req,
    res: res
  }, criteria);
}

function responsePolicy(criteria, _data, options) {
  sails.log.info('responsePolicy');
  var req = this.req;
  var res = this.res;
  var user = req.owner;
  var method = PermissionService.getMethod(req);
  var isResponseArray = _.isArray(_data);

  var data = isResponseArray ? _data : [_data];

  // get property names in the model that refer to associations of the "model" type
  // purpose : detect populated keys !
  var modelAssociations = [];
  if(req.options
    && req.options.associations
    && _.isArray(req.options.associations)){
    modelAssociations =
    _.map(
      _.filter(req.options.associations, {
        type: "model"
      }),
      function(association){
        // add primary key
        if(sails
          && sails.models
          && association.model
          && sails.models[association.model]
        ){
          association.primaryKey = sails.models[association.model].primaryKey;
        }
        return association;
      }
    );
  }

  sails.log.silly('data', data);
  sails.log.silly('options', options);
  sails.log.silly('criteria!', criteria);

  var permitted = data.reduce(function(memo, item) {
    // item to plain object to allow prototype values deletion
    if(typeof item.toObject === "function") {
      item = item.toObject();
    }
    // flatten item associations so that waterline filters work on populated values
    var fiterableItem = _.merge({}, item);
    _.forEach(modelAssociations, function(association){
      if(fiterableItem[association.alias] && fiterableItem[association.alias][association.primaryKey]){
        fiterableItem[association.alias] = fiterableItem[association.alias][association.primaryKey];
      }
    });
    var blacklists = [], passing = false;
    _.forEach(criteria, function(crit) {
      var filtered = wlFilter([fiterableItem], {
        where: {
          or: [crit.where]
        }
      }).results;

      if (filtered.length) {
        if (crit.blacklist && crit.blacklist.length) {
          blacklists.push(crit.blacklist);
        } else {
          // no blacklist : show everything
          blacklists.push([]);
        }
        passing = true;
      }
    });
    var _blacklists = _.intersection.apply(_, blacklists);
    if (_blacklists && _blacklists.length) {
      _blacklists.forEach(function(term) {
        delete item[term];
      });
    }
    if(passing){
      memo.push(item);
    }
    return memo;
  }, []);

  if (isResponseArray) {
    return res._ok(permitted, options);
  } else if (permitted.length === 0) {
    sails.log.silly('permitted.length === 0');
    return res.forbidden({
        error: 'Cannot perform action [read] on foreign object'
    });
  } else {
    res._ok(permitted[0], options);
  }
}
